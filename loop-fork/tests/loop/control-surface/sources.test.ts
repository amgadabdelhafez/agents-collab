import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertContainedPath,
  createFilesystemReadModelCapabilities,
  readJsonlSnapshot,
  readJsonSnapshot,
} from "../../../src/loop/control-surface/sources";

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "control-surface-"));

test("bounded snapshots use exact bytes and reject malformed UTF-8", () => {
  const root = makeRoot();
  try {
    const path = join(root, "state.json");
    writeFileSync(path, '{"value":1}\n');
    const first = readJsonSnapshot(path, { maxBytes: 64, observedAt: 10 });
    writeFileSync(path, '{"value":1}');
    const second = readJsonSnapshot(path, { maxBytes: 64, observedAt: 10 });
    expect(first.status).toBe("available");
    expect(first.revision).not.toBe(second.revision);

    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    expect(
      readJsonSnapshot(path, { maxBytes: 64, observedAt: 10 }).status
    ).toBe("malformed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem capabilities discover only directories and materialize known sources", () => {
  const root = makeRoot();
  const runDir = join(root, "repo-a", "7");
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  mkdirSync(join(runDir, "utility"), { recursive: true });
  try {
    writeFileSync(join(root, "not-a-repo"), "ignored");
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({
        repoId: "repo-a",
        runId: "7",
        tmuxAdapterIdentity: {
          processBirthId: "darwin:1",
          serverPid: 2,
          socketPath: "/private/socket",
          version: 1,
        },
      })
    );
    writeFileSync(join(runDir, "transcript.jsonl"), '{"kind":"status"}\n');
    writeFileSync(join(runDir, "hooks", "codex.jsonl"), '{"event":"stop"}\n');
    const capabilities = createFilesystemReadModelCapabilities(root, () => 123);
    expect(capabilities.listRuns()).toEqual([
      { repoId: "repo-a", runId: "7", runDir, storageRoot: root },
    ]);
    const selected = capabilities.listRuns()[0];
    if (!selected) {
      throw new Error("Expected a discovered run");
    }
    const sources = capabilities.readSources(selected);
    expect(sources.manifest.status).toBe("available");
    expect(sources.transcript.value).toEqual([{ kind: "status" }]);
    expect(sources.hooks.value).toEqual([{ event: "stop" }]);
    expect(sources.adapter.value).toMatchObject({ serverPid: 2 });
    expect(sources.bridge.status).toBe("missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshots distinguish missing, oversized, malformed JSONL, and valid rows", () => {
  const root = makeRoot();
  try {
    const path = join(root, "events.jsonl");
    expect(
      readJsonlSnapshot(path, { maxBytes: 8, observedAt: 10 }).status
    ).toBe("missing");
    writeFileSync(path, "123456789");
    expect(
      readJsonlSnapshot(path, { maxBytes: 8, observedAt: 10 }).status
    ).toBe("oversize");
    writeFileSync(path, '{"a":1}\nnot-json\n');
    expect(
      readJsonlSnapshot(path, { maxBytes: 64, observedAt: 10 }).status
    ).toBe("malformed");
    writeFileSync(path, '{"a":1}\n\n{"b":2}\n');
    expect(
      readJsonlSnapshot(path, { maxBytes: 64, observedAt: 10 }).value
    ).toEqual([{ a: 1 }, { b: 2 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence paths must remain contained by the selected run directory", () => {
  const root = makeRoot();
  const runDir = join(root, "repo", "7");
  mkdirSync(runDir, { recursive: true });
  try {
    expect(assertContainedPath(runDir, join(runDir, "manifest.json"))).toBe(
      join(runDir, "manifest.json")
    );
    expect(() =>
      assertContainedPath(runDir, join(runDir, "..", "secret"))
    ).toThrow();
    expect(() => assertContainedPath(runDir, runDir)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem capabilities reject file symlinks and traversal-shaped locators", () => {
  const root = makeRoot();
  const runDir = join(root, "repo-a", "7");
  const external = join(root, "external.json");
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(external, '{"repoId":"repo-a","runId":"7"}');
    symlinkSync(external, join(runDir, "manifest.json"));
    const capabilities = createFilesystemReadModelCapabilities(root, () => 123);
    const selected = capabilities.listRuns()[0];
    if (!selected) {
      throw new Error("Expected a discovered run");
    }
    expect(capabilities.readSources(selected).manifest.status).toBe(
      "unavailable"
    );
    expect(() =>
      capabilities.readSources({
        repoId: "..",
        runId: "outside",
        runDir: join(root, "..", "outside"),
        storageRoot: root,
      })
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked hook evidence degrades without aborting the projection", () => {
  const root = makeRoot();
  const runDir = join(root, "repo-a", "7");
  const external = join(root, "external.jsonl");
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  try {
    writeFileSync(
      join(runDir, "manifest.json"),
      '{"repoId":"repo-a","runId":"7"}'
    );
    writeFileSync(external, '{"event":"secret"}\n');
    symlinkSync(external, join(runDir, "hooks", "codex.jsonl"));
    const capabilities = createFilesystemReadModelCapabilities(root, () => 123);
    const selected = capabilities.listRuns()[0];
    if (!selected) {
      throw new Error("Expected a discovered run");
    }
    expect(capabilities.readSources(selected).hooks.status).toBe("unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

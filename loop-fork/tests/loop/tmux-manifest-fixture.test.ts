import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRunManifestHandle } from "../../src/loop/run-state";
import {
  describeTmuxTarget,
  targetFromManifest,
} from "../../src/loop/tmux-socket";

const fixtureRoot = resolve(
  import.meta.dir,
  "../fixtures/tmux-socket-normalization"
);
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

test("producer fixture index hashes every compatibility artifact", () => {
  const index = JSON.parse(
    readFileSync(join(fixtureRoot, "fixture-index.json"), "utf8")
  ) as {
    artifacts: Array<{ file: string; sha256: string }>;
    capture: {
      rawManifestSha256: string;
      tmuxArgvSha256: string;
      tmuxCommandKinds: string[];
    };
    normalization: { script: string; scriptSha256: string };
    producer: {
      binarySha256: string;
      capturedAtUtc: string;
      sourceCommit: string;
    };
  };
  expect(index.artifacts.length).toBe(3);
  for (const artifact of index.artifacts) {
    expect(sha256(readFileSync(join(fixtureRoot, artifact.file)))).toBe(
      artifact.sha256
    );
  }
  expect(index.producer.binarySha256).toMatch(/^[0-9a-f]{64}$/);
  expect(index.producer.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(Number.isFinite(Date.parse(index.producer.capturedAtUtc))).toBeTrue();
  expect(index.capture.rawManifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(index.capture.tmuxArgvSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(index.capture.tmuxCommandKinds).toEqual([
    "version-probe:-V",
    "prelaunch:has-session",
    "launch:new-session",
    "cleanup-reprobe:has-session",
  ]);
  const normalizer = resolve(
    fixtureRoot,
    "../../..",
    index.normalization.script
  );
  expect(sha256(readFileSync(normalizer))).toBe(
    index.normalization.scriptSha256
  );
  const trace = readFileSync(join(fixtureRoot, "tmux-argv.tsv"), "utf8");
  const traceLines = trace.trim().split("\n");
  expect(traceLines).toHaveLength(4);
  expect(traceLines[0]).toBe("-V");
  expect(traceLines[1]).toBe("-S\t<SOCKET>\thas-session\t-t\tworkspace-loop-1");
  const newSessionArgv = traceLines[2].split("\t");
  expect(newSessionArgv.slice(0, 12)).toEqual([
    "-S",
    "<SOCKET>",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-x",
    "220",
    "-y",
    "60",
    "-s",
  ]);
  expect(newSessionArgv[12]).toBe("workspace-loop-1");
  expect(traceLines[2]).toContain("<SCRATCH>");
  expect(traceLines[2]).not.toContain(tmpdir());
  expect(traceLines[3]).toBe("-S\t<SOCKET>\thas-session\t-t\tworkspace-loop-1");
});

test("legacy fixture is derived by removing only tmuxSocket", () => {
  const current = JSON.parse(
    readFileSync(join(fixtureRoot, "manifest-new.json"), "utf8")
  ) as Record<string, unknown>;
  const legacy = JSON.parse(
    readFileSync(join(fixtureRoot, "manifest-legacy.json"), "utf8")
  ) as Record<string, unknown>;
  const derived = { ...current };
  Reflect.deleteProperty(derived, "tmuxSocket");
  expect(legacy).toEqual(derived);
});

test("producer fixture targets exact socket while legacy fixture fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-manifest-fixture-test-"));
  scratch.push(root);
  const currentPath = join(root, "current.json");
  const legacyPath = join(root, "legacy.json");
  writeFileSync(
    currentPath,
    readFileSync(join(fixtureRoot, "manifest-new.json"))
  );
  writeFileSync(
    legacyPath,
    readFileSync(join(fixtureRoot, "manifest-legacy.json"))
  );
  const currentHandle = readRunManifestHandle(currentPath);
  const legacyHandle = readRunManifestHandle(legacyPath);
  expect(currentHandle).toBeDefined();
  expect(legacyHandle).toBeDefined();
  const target = targetFromManifest(currentHandle as never);
  expect(describeTmuxTarget(target as never)).toEqual({
    session: "workspace-loop-1",
    socket: "/tmp/loop-fixture/producer.sock",
  });
  expect(targetFromManifest(legacyHandle as never)).toBeUndefined();
});

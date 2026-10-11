import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LoopSupervisorDirectory,
  loopRunEndpointRoute,
} from "../../src/loop/loop-supervisor-directory";
import {
  createRunManifest,
  setRunManifestState,
  writeRunManifest,
} from "../../src/loop/run-state";

test("manifest-backed supervisor routes resolve only active exact runs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-supervisors-")));
  const runDir = join(root, "1");
  const manifestPath = join(runDir, "manifest.json");
  try {
    const manifest = createRunManifest(
      {
        cwd: root,
        mode: "paired",
        pid: process.pid,
        primaryAgent: "codex",
        repoId: "repo-1",
        runId: "1",
        state: "working",
        tmuxPaneLeft: "%1",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRight: "%2",
        tmuxPaneRightAgent: "codex",
      },
      "2026-08-30T10:00:00.000Z"
    );
    writeRunManifest(manifestPath, manifest);
    const directory = new LoopSupervisorDirectory([
      { manifestPath, supervisorId: "supervisor:harness" },
    ]);
    expect(directory.resolve("supervisor:harness")).toEqual({
      runDir,
      target: "codex",
    });
    expect(directory.resolve("supervisor:unknown")).toBeUndefined();
    writeRunManifest(
      manifestPath,
      setRunManifestState(manifest, "stopped", "2026-08-30T10:01:00.000Z")
    );
    expect(directory.resolve("supervisor:harness")).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("supervisor routes reject duplicate identities and noncanonical paths", () => {
  expect(
    () =>
      new LoopSupervisorDirectory([
        { manifestPath: "/missing", supervisorId: "not-a-supervisor" },
      ])
  ).toThrow("identity is invalid");
});

test("a binding whose manifest is missing routes nowhere instead of refusing construction, and routes once its manifest exists (fix8)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-supervisors-")));
  const runDir = join(root, "1");
  const manifestPath = join(runDir, "manifest.json");
  try {
    // Neither the run directory nor its manifest exists: a removed or
    // not-yet-started run is runtime state, never a start refusal.
    const directory = new LoopSupervisorDirectory([
      { manifestPath, seat: "codex", supervisorId: "supervisor:harness" },
    ]);
    expect(directory.resolve("supervisor:harness")).toBeUndefined();
    writeRunManifest(
      manifestPath,
      createRunManifest(
        {
          cwd: root,
          mode: "paired",
          pid: process.pid,
          primaryAgent: "codex",
          repoId: "repo-1",
          runId: "1",
          state: "working",
          tmuxPaneRight: "%2",
          tmuxPaneRightAgent: "codex",
        },
        "2026-08-30T10:00:00.000Z"
      )
    );
    expect(directory.resolve("supervisor:harness")).toEqual({
      runDir,
      target: "codex",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a manifest that appears late is still checked as at construction: a symlink is refused", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-supervisors-")));
  const manifestPath = join(root, "1", "manifest.json");
  try {
    const directory = new LoopSupervisorDirectory([
      { manifestPath, supervisorId: "supervisor:harness" },
    ]);
    mkdirSync(join(root, "1"));
    writeFileSync(join(root, "elsewhere.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), manifestPath);
    expect(() => directory.resolve("supervisor:harness")).toThrow(
      "supervisor manifest must be a regular non-symlink file"
    );
    // An existing symlink still refuses construction, as before.
    expect(
      () =>
        new LoopSupervisorDirectory([
          { manifestPath, supervisorId: "supervisor:harness" },
        ])
    ).toThrow("supervisor manifest must be a regular non-symlink file");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

const r9Manifest = (root: string) =>
  createRunManifest(
    {
      cwd: root,
      mode: "paired",
      pid: process.pid,
      primaryAgent: "codex",
      repoId: "repo-1",
      runId: "1",
      state: "working",
      tmuxPaneLeft: "%1",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRight: "%2",
      tmuxPaneRightAgent: "codex",
    },
    "2026-10-11T10:00:00.000Z"
  );

test("r9: a lease-resolved Loop run endpoint routes only an active run's declared seat in that run", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-supervisors-")));
  const runDir = join(root, "repo-1", "1");
  const manifestPath = join(runDir, "manifest.json");
  const write = (overrides: Record<string, unknown> = {}) =>
    writeRunManifest(manifestPath, {
      ...r9Manifest(root),
      ...overrides,
    } as ReturnType<typeof createRunManifest>);
  const endpoint = (seat: "claude" | "codex", dir = runDir) =>
    ({ kind: "loop-run", manifestPath, runDir: dir, seat }) as const;
  try {
    write();
    // The explicit seat wins over the primary agent.
    expect(loopRunEndpointRoute(endpoint("claude"))).toEqual({
      runDir,
      target: "claude",
    });
    expect(loopRunEndpointRoute(endpoint("codex"))).toEqual({
      runDir,
      target: "codex",
    });
    // A runDir that does not hold that manifest routes nowhere.
    expect(
      loopRunEndpointRoute(endpoint("claude", join(root, "repo-1", "2")))
    ).toBeUndefined();
    // An undeclared seat routes nowhere.
    write({ tmuxPaneLeftAgent: "codex" });
    expect(loopRunEndpointRoute(endpoint("claude"))).toBeUndefined();
    // A stopped run routes nowhere.
    write({ state: "stopped", status: "stopped" });
    expect(loopRunEndpointRoute(endpoint("codex"))).toBeUndefined();
    // A seat that is not a declared pane agent routes nowhere.
    write();
    expect(
      loopRunEndpointRoute({ ...endpoint("codex"), seat: "oss" as "codex" })
    ).toBeUndefined();
    // A removed run is not ready, never a throw.
    rmSync(runDir, { force: true, recursive: true });
    expect(loopRunEndpointRoute(endpoint("codex"))).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("r9: a lease-resolved endpoint whose manifest became a symlink routes nowhere instead of throwing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-supervisors-")));
  const runDir = join(root, "repo-1", "1");
  const manifestPath = join(runDir, "manifest.json");
  try {
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(join(root, "other.json"), r9Manifest(root));
    symlinkSync(join(root, "other.json"), manifestPath);
    expect(
      loopRunEndpointRoute({
        kind: "loop-run",
        manifestPath,
        runDir,
        seat: "codex",
      })
    ).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

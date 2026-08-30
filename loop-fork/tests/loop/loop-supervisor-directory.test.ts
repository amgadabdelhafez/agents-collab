import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopSupervisorDirectory } from "../../src/loop/loop-supervisor-directory";
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
        repoId: "repo-1",
        runId: "1",
        state: "working",
      },
      "2026-08-30T10:00:00.000Z"
    );
    writeRunManifest(manifestPath, manifest);
    const directory = new LoopSupervisorDirectory([
      { manifestPath, supervisorId: "supervisor:harness" },
    ]);
    expect(directory.resolve("supervisor:harness")).toEqual({
      runDir,
      target: "supervisor",
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

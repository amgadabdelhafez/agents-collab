import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupRunOwnedProcesses,
  registerRunBridgeProcess,
  runProcessCleanupInternals,
  unregisterRunBridgeProcess,
} from "../../src/loop/run-process-cleanup";
import { createRunManifest } from "../../src/loop/run-state";

const makeRunDir = (): string =>
  mkdtempSync(join(tmpdir(), "loop-process-cleanup-"));

test("teardown signals only bridge processes registered to the exact run", () => {
  const runDir = makeRunDir();
  const otherRun = `${runDir}-other`;
  const signals: number[] = [];
  const original = { ...runProcessCleanupInternals.deps };
  const matching = registerRunBridgeProcess(runDir, "claude", 4101);
  registerRunBridgeProcess(runDir, "codex", 4102);
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 4101
        ? `loop __bridge-mcp ${runDir} claude`
        : `loop __bridge-mcp ${otherRun} codex`;
    runProcessCleanupInternals.deps.listeningPids = () => [];
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result.killed).toEqual([4101]);
    expect(result.skipped).toEqual([
      { pid: 4102, reason: "bridge-command-mismatch" },
    ]);
    expect(signals).toEqual([4101]);
  } finally {
    unregisterRunBridgeProcess(matching);
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown requires both app-server command and owned listener port", () => {
  const runDir = makeRunDir();
  const signals: number[] = [];
  const original = { ...runProcessCleanupInternals.deps };
  const manifest = createRunManifest({
    codexAppServerPid: 4501,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    cwd: "/repo",
    mode: "paired",
    pid: 100,
    repoId: "repo-1",
    runId: "1",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://";
    runProcessCleanupInternals.deps.listeningPids = () => [44_149];
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };

    const protectedResult = cleanupRunOwnedProcesses(runDir, manifest);
    expect(protectedResult.killed).toEqual([]);
    expect(protectedResult.skipped).toEqual([
      { pid: 4501, reason: "app-server-identity-mismatch" },
    ]);

    runProcessCleanupInternals.deps.listeningPids = () => [4501];
    const ownedResult = cleanupRunOwnedProcesses(runDir, manifest);
    expect(ownedResult.killed).toEqual([4501]);
    expect(signals).toEqual([4501]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

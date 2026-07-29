import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupRunOwnedProcesses,
  gcAbandonedRunProcesses,
  registerRunBridgeProcess,
  runProcessCleanupInternals,
  unregisterRunBridgeProcess,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

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

test("startup GC reaps only provably abandoned runs in the current repository", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const repoRuns = join(storageRoot, repoId);
  const signals: number[] = [];
  const logs: string[] = [];
  let tmuxListCalls = 0;
  const manifestFor = (
    runId: string,
    pid: number,
    overrides: Parameters<typeof createRunManifest>[0] = {
      cwd: "/repo",
      mode: "paired",
      pid,
      repoId,
      runId,
    }
  ) =>
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid,
      repoId,
      runId,
      ...overrides,
    });
  const write = (runId: string, manifest: ReturnType<typeof manifestFor>) => {
    const runDir = join(repoRuns, runId);
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(join(runDir, "manifest.json"), manifest);
    return runDir;
  };
  const abandonedDir = write(
    "88",
    manifestFor("88", 8800, {
      codexAppServerPid: 8801,
      codexRemoteUrl: "ws://127.0.0.1:4500",
      cwd: "/repo",
      mode: "paired",
      pid: 8800,
      repoId,
      runId: "88",
      state: "submitted",
    })
  );
  const abandonedBridge = registerRunBridgeProcess(
    abandonedDir,
    "claude",
    8802
  );
  write(
    "87",
    manifestFor("87", 8700, {
      cwd: "/repo",
      mode: "paired",
      pid: 8700,
      repoId,
      runId: "87",
      state: "completed",
    })
  );
  const liveLauncherDir = write("89", manifestFor("89", 8900));
  registerRunBridgeProcess(liveLauncherDir, "claude", 8902);
  const unknownTmuxDir = write(
    "90",
    manifestFor("90", 9000, {
      cwd: "/repo",
      mode: "paired",
      pid: 9000,
      repoId,
      runId: "90",
      tmuxSession: "unknown-loop",
    })
  );
  registerRunBridgeProcess(unknownTmuxDir, "claude", 9002);
  const liveTmuxDir = write(
    "98",
    manifestFor("98", 9800, {
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  const liveBridge = registerRunBridgeProcess(liveTmuxDir, "claude", 9802);
  const malformedDir = join(repoRuns, "bad");
  mkdirSync(malformedDir, { recursive: true });
  writeFileSync(join(malformedDir, "manifest.json"), "{}\n", "utf8");
  write("91", manifestFor("92", 9100));
  const otherRepoDir = join(storageRoot, "repo-other", "1");
  mkdirSync(otherRepoDir, { recursive: true });
  writeRunManifest(
    join(otherRepoDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 1111,
      codexRemoteUrl: "ws://127.0.0.1:4511",
      cwd: "/other",
      mode: "paired",
      pid: 1110,
      repoId: "repo-other",
      runId: "1",
    })
  );

  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          if (pid === 8801) {
            return "codex app-server --listen ws://127.0.0.1:4500";
          }
          if (pid === 8802) {
            return `loop __bridge-mcp ${abandonedDir} claude`;
          }
          throw new Error(`must not inspect process ${pid}`);
        },
        listTmuxSessions: () => {
          tmuxListCalls += 1;
          return undefined;
        },
        listeningPids: (port) => (port === 4500 ? [8801] : []),
        pidAlive: (pid) => {
          if (pid === 8700) {
            throw new Error(
              "settled runs without ownership need no liveness probe"
            );
          }
          return pid === 8900;
        },
        signal: (pid) => {
          signals.push(pid);
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toEqual({
      cleaned: 1,
      kept: 6,
      killed: [8802, 8801],
      scanned: 5,
      skipped: [],
    });
    expect(tmuxListCalls).toBe(1);
    expect(signals).toEqual([8802, 8801]);
    expect(logs).toEqual([
      '[loop] cleaned 1 abandoned run for "repo-current" (2 processes signaled)',
    ]);
    const abandonedManifest = readRunManifest(
      join(abandonedDir, "manifest.json")
    );
    expect(abandonedManifest).toMatchObject({
      state: "failed",
      status: "failed",
    });
    expect(abandonedManifest?.codexAppServerPid).toBeUndefined();
    expect(abandonedManifest?.codexRemoteUrl).toBeUndefined();
    expect(existsSync(abandonedBridge)).toBe(false);
    expect(existsSync(liveBridge)).toBe(true);
    expect(readRunManifest(join(liveTmuxDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      status: "running",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC never signals stale-run processes that fail ownership proof", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "92");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 9201,
      codexRemoteUrl: "ws://127.0.0.1:4520",
      cwd: "/repo",
      mode: "paired",
      pid: 9200,
      repoId,
      runId: "92",
    })
  );
  registerRunBridgeProcess(runDir, "claude", 9202);
  const signals: number[] = [];
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) =>
          pid === 9202
            ? "loop __bridge-mcp /another/run claude"
            : "codex app-server --listen ws://127.0.0.1:4520",
        listTmuxSessions: () => new Set(),
        listeningPids: () => [],
        pidAlive: () => false,
        signal: (pid) => signals.push(pid),
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result).toMatchObject({ cleaned: 1, killed: [] });
    expect(result.skipped).toEqual([
      { pid: 9202, reason: "bridge-command-mismatch" },
      { pid: 9201, reason: "app-server-identity-mismatch" },
    ]);
    expect(signals).toEqual([]);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "failed",
      status: "failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC preserves a run present in the bounded tmux snapshot", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "98");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 9801,
      codexRemoteUrl: "ws://127.0.0.1:4598",
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  const bridgeRecord = registerRunBridgeProcess(runDir, "claude", 9802);
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          throw new Error(`live run process ${pid} must not be inspected`);
        },
        listTmuxSessions: () => new Set(["harvto-loop-98"]),
        listeningPids: () => {
          throw new Error("live run listener must not be inspected");
        },
        pidAlive: () => false,
        signal: () => {
          throw new Error("live run must not be signaled");
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result).toEqual({
      cleaned: 0,
      kept: 1,
      killed: [],
      scanned: 1,
      skipped: [],
    });
    expect(existsSync(bridgeRecord)).toBe(true);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      status: "running",
      tmuxSession: "harvto-loop-98",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC retains app-server ownership evidence after a signal failure", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "93");
  const manifestPath = join(runDir, "manifest.json");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      cwd: "/repo",
      mode: "paired",
      pid: 9300,
      repoId,
      runId: "93",
    })
  );
  const commonDeps = {
    commandForPid: () => "codex app-server --listen ws://127.0.0.1:4530",
    listTmuxSessions: () => new Set<string>(),
    listeningPids: () => [9301],
    pidAlive: () => false,
  };
  try {
    const failed = gcAbandonedRunProcesses({
      deps: {
        ...commonDeps,
        signal: () => {
          const error = new Error(
            "operation not permitted"
          ) as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(failed).toMatchObject({
      cleaned: 1,
      killed: [],
      skipped: [{ pid: 9301, reason: "signal-failed:EPERM" }],
    });
    expect(readRunManifest(manifestPath)).toMatchObject({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      state: "failed",
    });

    const retriedSignals: number[] = [];
    const retried = gcAbandonedRunProcesses({
      deps: {
        ...commonDeps,
        signal: (pid) => retriedSignals.push(pid),
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(retried).toMatchObject({ cleaned: 1, killed: [9301], skipped: [] });
    expect(retriedSignals).toEqual([9301]);
    expect(readRunManifest(manifestPath)?.codexAppServerPid).toBeUndefined();
    expect(readRunManifest(manifestPath)?.codexRemoteUrl).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC contains tmux snapshot failures and preserves tmux-owned runs", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "98");
  const logs: string[] = [];
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        listTmuxSessions: () => {
          throw new Error("tmux unavailable");
        },
        pidAlive: () => {
          throw new Error("unknown tmux liveness must preserve the run");
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({ cleaned: 0, kept: 1, scanned: 1 });
    expect(logs).toEqual([
      "[loop] abandoned-run cleanup could not inspect tmux; preserving tmux-owned runs: tmux unavailable",
    ]);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      tmuxSession: "harvto-loop-98",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC contains manifest repair failures before signaling and continues", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const failedRunDir = join(storageRoot, repoId, "93");
  const nextRunDir = join(storageRoot, repoId, "94");
  const failedManifestPath = join(failedRunDir, "manifest.json");
  const nextManifestPath = join(nextRunDir, "manifest.json");
  const logs: string[] = [];
  const signals: number[] = [];
  mkdirSync(failedRunDir, { recursive: true });
  mkdirSync(nextRunDir, { recursive: true });
  writeRunManifest(
    failedManifestPath,
    createRunManifest({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      cwd: "/repo",
      mode: "paired",
      pid: 9300,
      repoId,
      runId: "93",
    })
  );
  writeRunManifest(
    nextManifestPath,
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9400,
      repoId,
      runId: "94",
    })
  );
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: () => "codex app-server --listen ws://127.0.0.1:4530",
        listTmuxSessions: () => new Set(),
        listeningPids: () => [9301],
        pidAlive: () => false,
        signal: (pid) => signals.push(pid),
        updateManifest: (manifestPath, update) => {
          if (manifestPath === failedManifestPath) {
            throw new Error("manifest is read-only");
          }
          return updateRunManifest(manifestPath, update);
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({ cleaned: 1, kept: 1, scanned: 1 });
    expect(signals).toEqual([]);
    expect(logs).toEqual([
      '[loop] abandoned-run cleanup skipped run "93": manifest is read-only',
      '[loop] cleaned 1 abandoned run for "repo-current" (0 processes signaled)',
    ]);
    expect(readRunManifest(failedManifestPath)).toMatchObject({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      state: "submitted",
    });
    expect(readRunManifest(nextManifestPath)).toMatchObject({
      state: "failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC retains bridge registration after a signal failure", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "95");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9500,
      repoId,
      runId: "95",
    })
  );
  const bridgeRecord = registerRunBridgeProcess(runDir, "claude", 9502);
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: () => `loop __bridge-mcp ${runDir} claude`,
        listTmuxSessions: () => new Set(),
        pidAlive: () => false,
        signal: () => {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({
      cleaned: 1,
      killed: [],
      skipped: [{ pid: 9502, reason: "signal-failed:EBUSY" }],
    });
    expect(existsSync(bridgeRecord)).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

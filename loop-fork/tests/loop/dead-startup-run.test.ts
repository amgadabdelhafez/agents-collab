// A failed paired start must not lock its workspace forever
// (fix8-launch-startup).
//
// Observed 2026-10-11 with the installed r7 build: a Claude readiness failure
// preserved the session for recovery and left the run `input-required`. Once
// that session was gone, the run's detached Codex app-server (its own process
// group) and its bridge MCP worker kept running, and every later launch was
// refused: "run 1 ... is input-required, not stopped, failed, or completed".
//
// The launch scan now fails such a run, and ends its own processes, only when
// its tmux session is positively absent AND its launcher is dead. Every test
// fakes tmux, the socket endpoint and process liveness; the real
// run-process cleanup is driven only through its injectable probes.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import type { RunProcessCleanupResult } from "../../src/loop/run-process-cleanup";
import { runProcessCleanupInternals } from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  type RunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
} from "../../src/loop/run-state";
import {
  type TmuxEndpointState,
  type TmuxTarget,
  targetArgv,
} from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";

type Liveness = "dead" | "live" | "unknown";

const SOCKET = "/tmp/ls-startup/default";
const UPDATED_AT = "2026-10-11T10:00:00.000Z";
const NOW = "2026-10-11T12:00:00.000Z";
const LAUNCHER = 1001;
const ATTEMPT = 1002;
const APP_SERVER = 1003;
const BRIDGE_WORKER = 1004;
const BRIDGE_MCP = 1005;

const makeOptions = (): Options =>
  ({
    agent: "claude",
    cavemanMode: "lite",
    cavemanModeSource: "default",
    codexModel: "test-model",
    doneSignal: "<done/>",
    format: "raw",
    governessCooldownSeconds: 60,
    governessHeight: "40%",
    governessIdleSeconds: 60,
    governessMaxRecoveries: 1,
    governessModel: "test-model",
    governessUrl: "http://127.0.0.1:1",
    helperCavemanMode: "full",
    helperCavemanModeSource: "default",
    maxIterations: 1,
    pairedMode: true,
    pairWith: "codex",
    proof: "verify",
    review: "claudex",
    tmux: true,
    worktree: false,
  }) as Options;

interface World {
  ended: Array<{ runDir: string; runId: string; state: string }>;
  endpoint: TmuxEndpointState;
  livePids: Set<number>;
  logs: string[];
  session: Liveness;
  sleeps: number;
  /** Which pids the fake teardown of a run ends. */
  stopsOnSignal: Set<number>;
  /** Pids the fake teardown signals that do not exit. */
  survivors: Set<number>;
}

const newWorld = (): World => ({
  // The bug shape: the shared socket still serves other sessions, and this
  // run's session answers positively dead on it.
  endpoint: "present",
  ended: [],
  livePids: new Set([4242, APP_SERVER, BRIDGE_WORKER, BRIDGE_MCP]),
  logs: [],
  session: "dead",
  sleeps: 0,
  stopsOnSignal: new Set([APP_SERVER, BRIDGE_WORKER, BRIDGE_MCP]),
  survivors: new Set(),
});

const socketOf = (target: TmuxTarget | undefined): string =>
  target ? String(targetArgv(target, "has-session")[2]) : "<none>";

const fakeDeps = (home: string, world: World) => ({
  // Every live recorded process counts (no other run shares them).
  classifyRecordedProcess: () => () => ({ count: true, rule: "recorded" }),
  endRunOwnedProcesses: (
    runDir: string,
    manifest: RunManifest
  ): RunProcessCleanupResult => {
    world.ended.push({ runDir, runId: manifest.runId, state: manifest.state });
    const killed = [...world.stopsOnSignal].filter((pid) =>
      world.livePids.has(pid)
    );
    for (const pid of killed) {
      if (!world.survivors.has(pid)) {
        world.livePids.delete(pid);
      }
    }
    return { killed, skipped: [] };
  },
  endpointState: (target: TmuxTarget | undefined): TmuxEndpointState =>
    socketOf(target) === SOCKET ? world.endpoint : "absent",
  env: { LOOP_TMUX_SOCKET: SOCKET } as Record<string, string | undefined>,
  home,
  isPidAlive: (pid: number) => world.livePids.has(pid),
  log: (line: string) => {
    world.logs.push(line);
  },
  makeClaimId: (() => {
    let next = 0;
    return () => `claim-${++next}`;
  })(),
  now: () => NOW,
  pid: 4242,
  pidStartedAt: () => undefined,
  platform: "darwin",
  processGroupAlive: () => false,
  sleep: () => {
    world.sleeps += 1;
    return Promise.resolve();
  },
  tmuxLiveness: (target: TmuxTarget | undefined): Liveness =>
    socketOf(target) === SOCKET ? world.session : "unknown",
  uid: 501,
});

interface Fixture {
  binding: LaunchWorkspaceBinding;
  home: string;
  repoDir: string;
  root: string;
}

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "loop-dead-start-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-dead-start-home-"));
  try {
    const binding: LaunchWorkspaceBinding = {
      branchRef: "refs/heads/main",
      repoId: resolveRepoId(root),
      root,
    };
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    await run({ binding, home, repoDir, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
};

/**
 * The r7 failed-start manifest: input-required, session and panes recorded,
 * launcher and launch attempt recorded, its own app-server at its exact
 * listen URL, and its bridge worker and bridge MCP registration on disk.
 */
const writeFailedStart = (
  fixture: Fixture,
  overrides: Partial<RunManifest> = {},
  runId = "1"
): { manifestPath: string; runDir: string } => {
  const runDir = join(fixture.repoDir, runId);
  mkdirSync(join(runDir, "run-processes"), { recursive: true });
  const manifest: RunManifest = {
    ...createRunManifest(
      {
        codexAppServerPid: APP_SERVER,
        codexRemoteUrl: "ws://127.0.0.1:45123",
        cwd: fixture.root,
        launchAttemptPid: ATTEMPT,
        mode: "paired",
        pid: LAUNCHER,
        repoId: fixture.binding.repoId,
        runId,
        state: "input-required",
        tmuxSocket: SOCKET,
        workspaceBinding: fixture.binding,
      },
      UPDATED_AT
    ),
    tmuxPaneLeft: "%1",
    tmuxPaneRight: "%2",
    tmuxSession: `dummy-loop-${runId}`,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(runDir, "bridge-worker.json"),
    `${JSON.stringify({ pid: BRIDGE_WORKER })}\n`
  );
  writeFileSync(
    join(runDir, "run-processes", `bridge-${BRIDGE_MCP}.json`),
    `${JSON.stringify({ kind: "bridge-mcp", pid: BRIDGE_MCP, runDir, source: "codex" })}\n`
  );
  return { manifestPath, runDir };
};

const launch = (fixture: Fixture, world: World) =>
  reservePairedLaunch(
    makeOptions(),
    fixture.binding,
    fakeDeps(fixture.home, world)
  );

test("a dead failed start is failed, its own processes are ended, and the next launch proceeds", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeFailedStart(fixture);
    const world = newWorld();

    const claim = await launch(fixture, world);

    expect(claim.storage.runId).toBe("2");
    expect(world.ended).toEqual([
      { runDir, runId: "1", state: "input-required" },
    ]);
    expect(world.livePids.has(APP_SERVER)).toBe(false);
    expect(world.livePids.has(BRIDGE_WORKER)).toBe(false);
    expect(readRunManifest(manifestPath)).toMatchObject({
      state: "failed",
      status: "failed",
      workspaceReleasedAt: NOW,
    });
    expect(
      world.logs.some((line) =>
        line.includes("failed dead startup run 1 (input-required")
      )
    ).toBe(true);
    expect(
      world.logs.some((line) =>
        line.includes("released workspace of dead run 1")
      )
    ).toBe(true);
  });
});

test("a dead submitted start is handled the same way", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture, {
      state: "submitted",
      status: "running",
    });
    const world = newWorld();
    const claim = await launch(fixture, world);
    expect(claim.storage.runId).toBe("2");
    expect(world.ended).toHaveLength(1);
    expect(readRunManifest(manifestPath)?.state).toBe("failed");
  });
});

const expectUntouched = async (
  fixture: Fixture,
  world: World,
  manifestPath: string,
  message: string
) => {
  const before = readRunManifest(manifestPath);
  await expect(launch(fixture, world)).rejects.toThrow(message);
  expect(world.ended).toEqual([]);
  expect(readRunManifest(manifestPath)).toEqual(before);
};

test("a preserved start whose session is still live stays locked and untouched", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture);
    const world = newWorld();
    world.session = "live";
    await expectUntouched(
      fixture,
      world,
      manifestPath,
      "is input-required, not stopped, failed, or completed"
    );
  });
});

test("a start whose session liveness is unknown stays locked and untouched", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture);
    const world = newWorld();
    world.session = "unknown";
    await expectUntouched(
      fixture,
      world,
      manifestPath,
      "is input-required, not stopped, failed, or completed"
    );
  });
});

test("a start whose launcher is still alive stays locked and untouched", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture);
    const world = newWorld();
    world.livePids.add(LAUNCHER);
    await expectUntouched(
      fixture,
      world,
      manifestPath,
      "is input-required, not stopped, failed, or completed"
    );
  });
});

test("a start whose launch attempt is still alive stays locked and untouched", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture);
    const world = newWorld();
    world.livePids.add(ATTEMPT);
    await expectUntouched(
      fixture,
      world,
      manifestPath,
      "is input-required, not stopped, failed, or completed"
    );
  });
});

test("a working run is never failed by the launch scan, even with everything dead", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture, {
      state: "working",
      status: "running",
    });
    const world = newWorld();
    await expectUntouched(
      fixture,
      world,
      manifestPath,
      "is working, not stopped, failed, or completed"
    );
  });
});

test("a dead start bound to another workspace is not this launch's to end", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture, {
      workspaceBinding: {
        branchRef: "refs/heads/elsewhere",
        repoId: fixture.binding.repoId,
        root: `${fixture.root}-elsewhere`,
      },
    });
    const before = readRunManifest(manifestPath);
    const world = newWorld();
    const claim = await launch(fixture, world);
    expect(claim.storage.runId).toBe("2");
    expect(world.ended).toEqual([]);
    expect(readRunManifest(manifestPath)).toEqual(before);
  });
});

test("a process that survives its end leaves the run failed but unreleased, after a bounded wait", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeFailedStart(fixture);
    const world = newWorld();
    world.survivors.add(APP_SERVER);

    await expect(launch(fixture, world)).rejects.toThrow(
      "loop reconcile failed-terminal 1"
    );

    expect(world.ended).toHaveLength(1);
    // Waited for it, but boundedly.
    expect(world.sleeps).toBe(10);
    const after = readRunManifest(manifestPath);
    expect(after?.state).toBe("failed");
    expect(after?.workspaceReleasedAt).toBeUndefined();

    // Once it is gone, the next launch releases it with the existing evidence.
    world.livePids.delete(APP_SERVER);
    const claim = await launch(fixture, world);
    expect(claim.storage.runId).toBe("2");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(NOW);
    expect(world.ended).toHaveLength(1);
  });
});

// The default teardown is the real run-process cleanup with only its process
// probes faked: the app-server is ended only on the positive identity binding
// (exact recorded listen URL, owned port, started by the record), the bridge
// worker and bridge MCP only on their exact argv tails with this run's dir.
test("the default teardown ends only processes positively bound to the dead run", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeFailedStart(fixture);
    const world = newWorld();
    const original = { ...runProcessCleanupInternals.deps };
    const signalled: number[] = [];
    const commands = new Map<number, string>([
      [APP_SERVER, "codex app-server --listen ws://127.0.0.1:45123"],
      [BRIDGE_WORKER, `/usr/local/bin/loop __bridge-worker ${runDir}`],
      [BRIDGE_MCP, `/usr/local/bin/loop __bridge-mcp ${runDir} codex`],
    ]);
    try {
      runProcessCleanupInternals.deps.commandForPid = (pid) =>
        world.livePids.has(pid) ? commands.get(pid) : undefined;
      runProcessCleanupInternals.deps.listeningPids = (port) =>
        port === 45_123 ? [APP_SERVER] : [];
      runProcessCleanupInternals.deps.ownProcessGroup = () => 999;
      runProcessCleanupInternals.deps.otherRunIndex = () => ({
        kind: "read",
        references: [],
        runs: [],
      });
      runProcessCleanupInternals.deps.processTable = () =>
        [APP_SERVER, BRIDGE_WORKER, BRIDGE_MCP].map((pid) => ({
          pgid: pid,
          pid,
          ppid: 1,
          startedAtMs: Date.parse(UPDATED_AT) - 60_000,
        }));
      runProcessCleanupInternals.deps.commandTable = () => commands;
      runProcessCleanupInternals.deps.signal = (pid) => {
        const target = Math.abs(pid);
        if (!world.livePids.has(target)) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
        signalled.push(target);
        world.livePids.delete(target);
      };
      const { endRunOwnedProcesses: _fake, ...deps } = fakeDeps(
        fixture.home,
        world
      );

      const claim = await reservePairedLaunch(
        makeOptions(),
        fixture.binding,
        deps
      );

      expect(claim.storage.runId).toBe("2");
      expect(signalled.sort()).toEqual([APP_SERVER, BRIDGE_WORKER, BRIDGE_MCP]);
      expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(NOW);
    } finally {
      Object.assign(runProcessCleanupInternals.deps, original);
    }
  });
});

test("the default teardown never signals an app-server not bound to the run's recorded URL", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeFailedStart(fixture);
    const world = newWorld();
    const original = { ...runProcessCleanupInternals.deps };
    const signalled: number[] = [];
    // Pid reuse: the recorded app-server pid now runs another run's server.
    const commands = new Map<number, string>([
      [APP_SERVER, "codex app-server --listen ws://127.0.0.1:50000"],
      [BRIDGE_WORKER, `/usr/local/bin/loop __bridge-worker ${runDir}-other`],
      [BRIDGE_MCP, `/usr/local/bin/loop __bridge-mcp ${runDir}0 codex`],
    ]);
    try {
      runProcessCleanupInternals.deps.commandForPid = (pid) =>
        world.livePids.has(pid) ? commands.get(pid) : undefined;
      runProcessCleanupInternals.deps.listeningPids = (port) =>
        port === 50_000 ? [APP_SERVER] : [];
      runProcessCleanupInternals.deps.ownProcessGroup = () => 999;
      runProcessCleanupInternals.deps.otherRunIndex = () => ({
        kind: "read",
        references: [],
        runs: [],
      });
      runProcessCleanupInternals.deps.processTable = () =>
        [APP_SERVER, BRIDGE_WORKER, BRIDGE_MCP].map((pid) => ({
          pgid: pid,
          pid,
          ppid: 1,
          startedAtMs: Date.parse(UPDATED_AT) - 60_000,
        }));
      runProcessCleanupInternals.deps.commandTable = () => commands;
      runProcessCleanupInternals.deps.signal = (pid) => {
        signalled.push(Math.abs(pid));
      };
      const { endRunOwnedProcesses: _fake, ...deps } = fakeDeps(
        fixture.home,
        world
      );

      await expect(
        reservePairedLaunch(makeOptions(), fixture.binding, deps)
      ).rejects.toThrow("loop reconcile failed-terminal 1");

      expect(signalled).toEqual([]);
      expect(readRunManifest(manifestPath)?.state).toBe("failed");
      expect(
        readRunManifest(manifestPath)?.workspaceReleasedAt
      ).toBeUndefined();
    } finally {
      Object.assign(runProcessCleanupInternals.deps, original);
    }
  });
});

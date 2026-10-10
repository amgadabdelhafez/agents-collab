// Dead-run workspace release (fix5-dead-run-release).
//
// Observed 2026-10-06 in ai-cur: sixteen dead runs (46-62) each held the
// workspace, and run 62 could never be released at all because its manifest
// records a tmux session and seven panes but no `tmuxSocket` (it predates
// socket recording). Every test here uses fakes for tmux liveness, the socket
// endpoint probe, and process liveness. No tmux server is started or
// contacted: `tmuxLiveness` and `endpointState` are always injected.

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmTeardownRelease,
  defaultGovernessDeps,
  type GovernessConfig,
  stopGovernessLoop,
} from "../../src/loop/governess";
import {
  reservePairedLaunch,
  tmuxRuntimeAbsentForManifest,
} from "../../src/loop/launch-reservation";
import {
  cleanupRunOwnedProcesses,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  reconcileLegacyStoppedRun,
  resolveRepoId,
  resolveStorageRoot,
} from "../../src/loop/run-state";
import {
  legacyTmuxSocketCandidates,
  type TmuxEndpointState,
  type TmuxTarget,
  targetArgv,
} from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";

type Liveness = "dead" | "live" | "unknown";

const UID = 501;
const LAUNCH_SOCKET = "/tmp/ls-dead/launch.sock";
const CREATED_AT = "2026-10-05T20:00:00.000Z";
const UPDATED_AT = "2026-10-05T21:00:00.000Z";

// The exact candidate set for a run-62-shaped manifest on darwin, plus the
// socket the current environment would select (LOOP_TMUX_SOCKET below).
const RUN_62_CANDIDATES = [
  `/tmp/tmux-${UID}/default`,
  `/private/tmp/tmux-${UID}/default`,
  `/tmp/ai-cur-tmux/tmux-${UID}/default`,
  `/private/tmp/ai-cur-tmux/tmux-${UID}/default`,
  LAUNCH_SOCKET,
];

const makeOptions = (overrides: Partial<Options> = {}): Options =>
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
    ...overrides,
  }) as Options;

const socketOf = (target: TmuxTarget | undefined): string => {
  if (!target) {
    return "<no target>";
  }
  const argv = targetArgv(target, "has-session");
  return String(argv[2]);
};

interface World {
  /** Endpoint state per socket. Unlisted sockets are absent. */
  endpoints: Map<string, TmuxEndpointState>;
  /** Liveness per socket. Unlisted sockets answer per `runtimeDefault`. */
  liveness: Map<string, Liveness>;
  livePids: Set<number>;
  logs: string[];
  probed: string[];
  startedAt: Map<number, number>;
}

const newWorld = (): World => ({
  endpoints: new Map(),
  liveness: new Map(),
  livePids: new Set([4242]),
  logs: [],
  probed: [],
  startedAt: new Map(),
});

const fakeDeps = (home: string, world: World) => ({
  endpointState: (target: TmuxTarget | undefined): TmuxEndpointState =>
    target ? (world.endpoints.get(socketOf(target)) ?? "absent") : "unknown",
  env: { LOOP_TMUX_SOCKET: LAUNCH_SOCKET } as Record<
    string,
    string | undefined
  >,
  home,
  isPidAlive: (pid: number) => world.livePids.has(pid),
  log: (line: string) => {
    world.logs.push(line);
  },
  makeClaimId: (() => {
    let next = 0;
    return () => `claim-${++next}`;
  })(),
  now: () => "2026-10-06T12:00:00.000Z",
  pid: 4242,
  pidStartedAt: (pid: number) => world.startedAt.get(pid),
  platform: "darwin",
  tmuxLiveness: (target: TmuxTarget | undefined): Liveness => {
    if (!target) {
      return "unknown";
    }
    const socket = socketOf(target);
    world.probed.push(socket);
    // A socket file that does not exist cannot answer about a session.
    return (
      world.liveness.get(socket) ??
      ((world.endpoints.get(socket) ?? "absent") === "absent"
        ? "unknown"
        : "dead")
    );
  },
  uid: UID,
});

interface Fixture {
  binding: LaunchWorkspaceBinding;
  home: string;
  repoDir: string;
  root: string;
}

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "loop-dead-run-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-dead-run-home-"));
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

interface RunShape {
  bridgeWorkerPid?: number;
  launchAttemptPid?: number;
  pid: number;
  registryPids?: number[];
  runId: string;
  socket?: string;
  state: string;
  status: string;
  workspaceReleasedAt?: string;
}

/**
 * Writes a manifest shaped like ai-cur run 62: a session and seven pane ids,
 * no `tmuxSocket` unless one is given.
 */
const writeRun = (fixture: Fixture, shape: RunShape): string => {
  const runDir = join(fixture.repoDir, shape.runId);
  mkdirSync(runDir, { recursive: true });
  const base = createRunManifest(
    {
      cwd: fixture.root,
      mode: "paired",
      pid: shape.pid,
      repoId: fixture.binding.repoId,
      runId: shape.runId,
      state: "stopped",
      workspaceBinding: fixture.binding,
    },
    CREATED_AT
  );
  const manifest: Record<string, unknown> = {
    ...base,
    createdAt: CREATED_AT,
    state: shape.state,
    status: shape.status,
    tmuxPaneAuPair: "%5",
    tmuxPaneGoverness: "%3",
    tmuxPaneLeft: "%1",
    tmuxPaneNanny: "%4",
    tmuxPaneRecon: ["%6"],
    tmuxPaneRight: "%2",
    tmuxPaneUtility: "%7",
    tmuxSession: `ai-cur-loop-${shape.runId}`,
    updatedAt: UPDATED_AT,
  };
  if (shape.launchAttemptPid !== undefined) {
    manifest.launchAttemptPid = shape.launchAttemptPid;
  }
  if (shape.socket !== undefined) {
    manifest.tmuxSocket = shape.socket;
  }
  if (shape.workspaceReleasedAt !== undefined) {
    manifest.workspaceReleasedAt = shape.workspaceReleasedAt;
  }
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const recordedAt = new Date(UPDATED_AT);
  if (shape.bridgeWorkerPid !== undefined) {
    const path = join(runDir, "bridge-worker.json");
    writeFileSync(path, `${JSON.stringify({ pid: shape.bridgeWorkerPid })}\n`);
    utimesSync(path, recordedAt, recordedAt);
  }
  for (const pid of shape.registryPids ?? []) {
    mkdirSync(join(runDir, "run-processes"), { recursive: true });
    const path = join(runDir, "run-processes", `bridge-${pid}.json`);
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "bridge-mcp", pid, runDir, source: "claude" })}\n`
    );
    utimesSync(path, recordedAt, recordedAt);
  }
  return manifestPath;
};

const RUN_62: RunShape = {
  bridgeWorkerPid: 62_003,
  launchAttemptPid: 62_002,
  pid: 62_001,
  registryPids: [62_004],
  runId: "62",
  state: "failed",
  status: "failed",
};

const runDirs = (repoDir: string): string[] =>
  readdirSync(repoDir)
    .filter((entry) => !entry.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const expectLaunchBlocked = async (
  fixture: Fixture,
  world: World,
  manifestPaths: string[],
  message: string | RegExp = "launch conflict"
) => {
  const before = manifestPaths.map((path) => readFileSync(path));
  const dirs = runDirs(fixture.repoDir);
  await expect(
    reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    )
  ).rejects.toThrow(message);
  manifestPaths.forEach((path, index) => {
    expect(readFileSync(path).equals(before[index] as Buffer)).toBe(true);
  });
  expect(runDirs(fixture.repoDir)).toEqual(dirs);
};

// --- The candidate set ------------------------------------------------------

const candidateStrings = (
  ...args: Parameters<typeof legacyTmuxSocketCandidates>
): string[] => legacyTmuxSocketCandidates(...args).map(String);

test("legacy socket candidates are the default, per-repo, and current-environment sockets", () => {
  expect(
    candidateStrings("ai-cur-loop-62", "62", {
      env: { LOOP_TMUX_SOCKET: LAUNCH_SOCKET },
      platform: "darwin",
      uid: UID,
    })
  ).toEqual(RUN_62_CANDIDATES);
  expect(
    candidateStrings("ai-cur-loop-62", "62", {
      env: {
        TMUX: "/private/tmp/outer-tmux/tmux-501/default,123,0",
        TMUX_TMPDIR: "/private/tmp/harness-d001-tmux",
      },
      platform: "linux",
      uid: UID,
    })
  ).toEqual([
    `/tmp/tmux-${UID}/default`,
    `/tmp/ai-cur-tmux/tmux-${UID}/default`,
    "/private/tmp/outer-tmux/tmux-501/default",
    "/private/tmp/harness-d001-tmux/tmux-501/default",
  ]);
  // A session that does not follow the <repo>-loop-<run> naming yields no
  // per-repo guess, and an unusable environment socket is dropped.
  expect(
    candidateStrings("custom", "62", {
      env: { LOOP_TMUX_SOCKET: "relative.sock" },
      platform: "linux",
      uid: UID,
    })
  ).toEqual([`/tmp/tmux-${UID}/default`]);
});

// --- Release of a legacy no-socket run --------------------------------------

test("a legacy no-socket run is released when every candidate socket is absent and every pid is dead", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, RUN_62);
    const world = newWorld();
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.reserved).toBe(true);
    expect(claim.storage.runId).toBe("63");
    // Every candidate was probed for the exact session.
    expect([...new Set(world.probed)].sort()).toEqual(
      [...RUN_62_CANDIDATES].sort()
    );
    expect(readRunManifest(manifestPath)).toMatchObject({
      state: "failed",
      status: "failed",
      workspaceReleasedAt: "2026-10-06T12:00:00.000Z",
    });
    expect(world.logs).toEqual([
      expect.stringContaining("released workspace of dead run 62"),
    ]);
  });
});

test("reconcile failed-terminal releases a legacy no-socket run on the same evidence", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, RUN_62);
    const world = newWorld();
    const deps = fakeDeps(fixture.home, world);
    const result = await reconcileLegacyStoppedRun(manifestPath, "62", {
      now: deps.now,
      pidCanStillOwnRun: (pid) => world.livePids.has(pid),
      runtimeAbsent: (path) => tmuxRuntimeAbsentForManifest(path, deps),
      terminalState: "failed",
    });
    expect(result).toEqual({
      runId: "62",
      status: "changed",
      workspaceReleasedAt: "2026-10-06T12:00:00.000Z",
    });
  });
});

test("a legacy no-socket run is blocked when any candidate socket has the session live", async () => {
  for (const live of RUN_62_CANDIDATES) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_62);
      const world = newWorld();
      world.endpoints.set(live, "present");
      world.liveness.set(live, "live");
      await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
      expect(world.logs).toEqual([]);

      const deps = fakeDeps(fixture.home, world);
      expect(await tmuxRuntimeAbsentForManifest(manifestPath, deps), live).toBe(
        false
      );
    });
  }
});

test("a legacy no-socket run is blocked when any recorded pid is alive", async () => {
  const recorded = {
    "bridge-worker.json": 62_003,
    launchAttemptPid: 62_002,
    pid: 62_001,
    "run-processes entry": 62_004,
  };
  for (const [name, pid] of Object.entries(recorded)) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_62);
      const world = newWorld();
      world.livePids.add(pid);
      await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
      expect(world.logs, name).toEqual([]);
    });
  }
});

test("a live recorded pid that provably started after the record is not ownership", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, RUN_62);
    const world = newWorld();
    world.livePids.add(62_003);
    world.startedAt.set(62_003, Date.parse("2026-10-06T08:00:00.000Z"));
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.storage.runId).toBe("63");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBeDefined();
  });
});

test("an unreadable recorded process entry blocks release", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, RUN_62);
    writeFileSync(
      join(fixture.repoDir, "62", "run-processes", "bridge-62004.json"),
      "{truncated"
    );
    await expectLaunchBlocked(fixture, newWorld(), [manifestPath], "run 62");
  });
});

test("an unknown liveness answer on any candidate still blocks", async () => {
  for (const socket of RUN_62_CANDIDATES) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_62);
      const world = newWorld();
      // A reachable server that will not answer about this session.
      world.endpoints.set(socket, "present");
      world.liveness.set(socket, "unknown");
      await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
    });
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_62);
      const world = newWorld();
      // An endpoint we could not even classify.
      world.endpoints.set(socket, "unknown");
      world.liveness.set(socket, "dead");
      await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
    });
  }
});

test("an invalid or conflicting recorded socket never falls back to the legacy candidates", async () => {
  const shapes: [string, (manifest: Record<string, unknown>) => void][] = [
    [
      "relative socket",
      (manifest) => {
        manifest.tmuxSocket = "relative/unusable.sock";
      },
    ],
    [
      "camel/snake disagreement",
      (manifest) => {
        manifest.tmuxSocket = "/tmp/ls-dead/a.sock";
        manifest.tmux_socket = "/tmp/ls-dead/b.sock";
      },
    ],
  ];
  for (const [name, mutate] of shapes) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_62);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      mutate(manifest);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      // Every candidate is absent, which would release a socket-less run.
      const world = newWorld();
      await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
      expect(world.probed, name).toEqual([]);
    });
  }
});

test("a non-terminal legacy run still blocks, even with every evidence dead", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, {
      ...RUN_62,
      state: "working",
      status: "running",
    });
    await expectLaunchBlocked(
      fixture,
      newWorld(),
      [manifestPath],
      "loop --tmux --run-id 62"
    );
  });
});

// --- Launch auto-release ----------------------------------------------------

test("launch auto-releases multiple dead terminal runs and proceeds", async () => {
  await withFixture(async (fixture) => {
    const paths = [
      writeRun(fixture, {
        pid: 46_001,
        runId: "46",
        state: "stopped",
        status: "stopped",
      }),
      writeRun(fixture, {
        pid: 47_001,
        runId: "47",
        state: "failed",
        status: "failed",
      }),
      writeRun(fixture, {
        pid: 48_001,
        runId: "48",
        socket: "/private/tmp/gone-tmux/tmux-501/default",
        state: "stopped",
        status: "stopped",
      }),
      writeRun(fixture, RUN_62),
    ];
    const world = newWorld();
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.reserved).toBe(true);
    expect(claim.storage.runId).toBe("63");
    for (const path of paths) {
      expect(readRunManifest(path)?.workspaceReleasedAt).toBe(
        "2026-10-06T12:00:00.000Z"
      );
    }
    expect(world.logs).toHaveLength(4);
    for (const runId of ["46", "47", "48", "62"]) {
      expect(
        world.logs.filter((line) =>
          line.includes(`released workspace of dead run ${runId} `)
        )
      ).toHaveLength(1);
    }
    expect(runDirs(fixture.repoDir)).toEqual(["46", "47", "48", "62", "63"]);
  });
});

test("launch does not auto-release when one run is alive, and names the command that resolves it", async () => {
  await withFixture(async (fixture) => {
    const dead = writeRun(fixture, {
      pid: 46_001,
      runId: "46",
      state: "stopped",
      status: "stopped",
    });
    const alive = writeRun(fixture, { ...RUN_62, runId: "62" });
    const world = newWorld();
    world.livePids.add(62_001);
    await expect(
      reservePairedLaunch(
        makeOptions(),
        fixture.binding,
        fakeDeps(fixture.home, world)
      )
    ).rejects.toThrow("loop reconcile failed-terminal 62");
    // The dead run is released even though another run blocks; the live one
    // is not.
    expect(readRunManifest(dead)?.workspaceReleasedAt).toBeDefined();
    expect(readRunManifest(alive)?.workspaceReleasedAt).toBeUndefined();
    expect(runDirs(fixture.repoDir)).toEqual(["46", "62"]);
  });
});

// --- A hand-edited release marker (the user's run 62) -----------------------

test("a hand-edited release marker on a legacy run is honoured only under the same evidence", async () => {
  const marked = { ...RUN_62, workspaceReleasedAt: "2026-10-06T09:00:00.000Z" };
  // All dead and absent: the launch proceeds and leaves the manifest alone.
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, marked);
    const before = readFileSync(manifestPath);
    const world = newWorld();
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.storage.runId).toBe("63");
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
    expect(world.logs).toEqual([]);
  });
  // A live candidate still blocks.
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, marked);
    const world = newWorld();
    world.endpoints.set(`/private/tmp/tmux-${UID}/default`, "present");
    world.liveness.set(`/private/tmp/tmux-${UID}/default`, "live");
    await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
  });
  // A live recorded pid still blocks.
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, marked);
    const world = newWorld();
    world.livePids.add(62_004);
    await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
  });
  // A marker back-dated before the run's last recorded activity cannot make a
  // live run process look like a later, unrelated one.
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, {
      ...RUN_62,
      workspaceReleasedAt: "2026-10-05T20:30:00.000Z",
    });
    const world = newWorld();
    world.livePids.add(62_001);
    world.startedAt.set(62_001, Date.parse("2026-10-05T20:45:00.000Z"));
    await expectLaunchBlocked(fixture, world, [manifestPath], "run 62");
  });
  // A non-terminal run with a hand-edited marker still blocks.
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, {
      ...marked,
      state: "working",
      status: "running",
    });
    await expectLaunchBlocked(fixture, newWorld(), [manifestPath], "run 62");
  });
});

// --- Teardown hands the workspace back (root cause) -------------------------
//
// ai-cur run 70 ended through a normal user teardown: the governess logged
// `exit: user requested teardown`, run-process-cleanup signalled its
// processes, and the manifest became stopped, but `workspaceReleasedAt` was
// never written. Every run therefore left a stale reservation behind.

const RUN_70_SOCKET = "/tmp/ls-dead/tmux-70.sock";

const RUN_70: RunShape = {
  bridgeWorkerPid: 70_003,
  launchAttemptPid: 70_002,
  pid: 70_001,
  registryPids: [70_004],
  runId: "70",
  socket: RUN_70_SOCKET,
  state: "working",
  status: "running",
};

interface TeardownScript {
  /**
   * Pids that exit when the real run-process cleanup signals them. Which pids
   * get signalled is the cleanup's own decision, not the script's.
   */
  exitOnSignal: number[];
  /** Teardown through the Temporal journal's close-then-kill path. */
  journal?: boolean;
  /** Whether the kill command itself fails. */
  killThrows?: boolean;
  /** What the session answers after the kill. */
  sessionAfterKill: Liveness;
}

/** What `ps -o command=` shows for each of run 70's recorded processes. */
const run70Command = (runDir: string, pid: number): string | undefined => {
  if (pid === 70_003) {
    return `/Users/me/.local/bin/loop __bridge-worker ${runDir}`;
  }
  if (pid === 70_004) {
    return `/Users/me/.local/bin/loop __bridge-mcp ${runDir} claude`;
  }
  return undefined;
};

const tearDown = async (
  fixture: Fixture,
  world: World,
  manifestPath: string,
  script: TeardownScript
): Promise<string[]> => {
  const events: string[] = [];
  const config = {
    agents: [],
    epoch: 1,
    logFile: join(fixture.home, "governess.jsonl"),
    manifestPath,
    journalTemporal: script.journal === true,
    runDir: join(fixture.repoDir, "70"),
    runId: "70",
    session: "ai-cur-loop-70",
  } as unknown as GovernessConfig;
  const runDir = join(fixture.repoDir, "70");
  const launch = fakeDeps(fixture.home, world);
  const original = { ...runProcessCleanupInternals.deps };
  // The real run-process cleanup decides what to signal; only the process
  // table it consults and the signal it sends are faked.
  runProcessCleanupInternals.deps.commandForPid = (pid) =>
    world.livePids.has(pid) ? run70Command(runDir, pid) : undefined;
  runProcessCleanupInternals.deps.listeningPids = () => [];
  runProcessCleanupInternals.deps.signal = (pid) => {
    if (!world.livePids.has(pid)) {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    if (script.exitOnSignal.includes(pid)) {
      world.livePids.delete(pid);
    }
  };
  try {
    await stopGovernessLoop(
      config,
      {
        ...defaultGovernessDeps(),
        appendLog: (_file, record) => {
          events.push((record as { event: string }).event);
        },
        cleanupRunProcesses: () =>
          cleanupRunOwnedProcesses(runDir, readRunManifest(manifestPath)),
        closeBeatWorkflow: script.journal
          ? () => Promise.resolve(undefined)
          : undefined,
        fenceCurrent: () => true,
        killSession: () => {
          world.liveness.set(RUN_70_SOCKET, script.sessionAfterKill);
          // The launcher's tmux client exits with its session.
          world.livePids.delete(70_001);
          world.livePids.delete(70_002);
          if (script.killThrows) {
            // The kill may even have landed, but the teardown was not told so;
            // an unconfirmed kill must not be followed by a release attempt.
            throw new Error("tmux control unavailable");
          }
        },
        now: () => Date.parse("2026-10-06T11:00:00.000Z"),
        releaseWorkspaceAfterTeardown: (teardown) =>
          confirmTeardownRelease(
            String(teardown.manifestPath),
            teardown.runId,
            {
              attempts: 3,
              now: () => "2026-10-06T11:00:01.000Z",
              pidCanStillOwnRun: (pid) => world.livePids.has(pid),
              retryMs: 0,
              runtimeAbsent: (path) =>
                tmuxRuntimeAbsentForManifest(path, launch),
              sleep: async () => undefined,
            }
          ),
      },
      "user requested teardown"
    );
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
  }
  return events;
};

const liveRun70World = (): World => {
  const world = newWorld();
  for (const pid of [70_001, 70_002, 70_003, 70_004]) {
    world.livePids.add(pid);
  }
  // The shared server still serves other sessions after this one is killed.
  world.endpoints.set(RUN_70_SOCKET, "present");
  world.liveness.set(RUN_70_SOCKET, "live");
  return world;
};

test("a clean teardown leaves the workspace released and the next launch proceeds with no conflict", async () => {
  for (const journal of [false, true]) {
    await withFixture(async (fixture) => {
      const name = journal ? "journal path" : "plain path";
      const manifestPath = writeRun(fixture, RUN_70);
      const world = liveRun70World();
      // Every recorded process exits when signalled. The detached bridge
      // worker (70_003) is ended only because the cleanup itself signals it.
      const events = await tearDown(fixture, world, manifestPath, {
        exitOnSignal: [70_003, 70_004],
        journal,
        sessionAfterKill: "dead",
      });
      expect(world.livePids.has(70_003), name).toBe(false);
      expect(events, name).toContain("workspace-released");
      expect(readRunManifest(manifestPath), name).toMatchObject({
        state: "stopped",
        status: "stopped",
        workspaceReleasedAt: "2026-10-06T11:00:01.000Z",
      });

      const claim = await reservePairedLaunch(
        makeOptions(),
        fixture.binding,
        fakeDeps(fixture.home, world)
      );
      expect(claim.storage.runId, name).toBe("71");
      // Released by the teardown itself, so the launch had nothing to repair.
      expect(world.logs, name).toEqual([]);
    });
  }
});

test("a teardown whose cleanup cannot confirm absence does not release", async () => {
  const unconfirmed: [string, TeardownScript][] = [
    [
      "the signalled bridge worker is still alive",
      { exitOnSignal: [70_004], sessionAfterKill: "dead" },
    ],
    [
      "the session still answers live",
      { exitOnSignal: [70_003, 70_004], sessionAfterKill: "live" },
    ],
    [
      "the session cannot be asked",
      { exitOnSignal: [70_003, 70_004], sessionAfterKill: "unknown" },
    ],
    [
      "the kill command failed",
      {
        exitOnSignal: [70_003, 70_004],
        killThrows: true,
        sessionAfterKill: "dead",
      },
    ],
    [
      "the kill command failed on the journal path",
      {
        exitOnSignal: [70_003, 70_004],
        journal: true,
        killThrows: true,
        sessionAfterKill: "dead",
      },
    ],
  ];
  for (const [name, script] of unconfirmed) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, RUN_70);
      const world = liveRun70World();
      const events = await tearDown(fixture, world, manifestPath, script);
      expect(events, name).not.toContain("workspace-released");
      const after = readRunManifest(manifestPath);
      expect(after?.state, name).toBe("stopped");
      expect(after?.workspaceReleasedAt, name).toBeUndefined();
      if (script.killThrows) {
        // Nothing is actually alive, so the next launch's own full-evidence
        // check releases it: the fallback the teardown leaves it to.
        const claim = await reservePairedLaunch(
          makeOptions(),
          fixture.binding,
          fakeDeps(fixture.home, world)
        );
        expect(claim.storage.runId, name).toBe("71");
        expect(world.logs, name).toEqual([
          expect.stringContaining("released workspace of dead run 70 "),
        ]);
        return;
      }
      // Still owned, so the next launch conflicts and names the command.
      await expectLaunchBlocked(
        fixture,
        world,
        [manifestPath],
        "loop reconcile stopped-run 70"
      );
    });
  }
});

// --- A dead run reconcile cannot release ------------------------------------
//
// `loop reconcile` refuses a run that recorded no workspace binding or no tmux
// session (missing-runtime-identity). The launch conflict for such a run must
// not tell the operator to run that command.

test("the conflict for a dead run with no binding or session names no reconcile command", async () => {
  const shapes: [string, string][] = [
    ["no workspace binding", "workspaceBinding"],
    ["no tmux session", "tmuxSession"],
  ];
  for (const [name, field] of shapes) {
    await withFixture(async (fixture) => {
      const manifestPath = writeRun(fixture, {
        pid: 80_001,
        runId: "80",
        socket: "/tmp/ls-dead/tmux-80.sock",
        state: "stopped",
        status: "stopped",
      });
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest[field];
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const world = newWorld();

      const refusal = await reconcileLegacyStoppedRun(manifestPath, "80", {
        now: () => "2026-10-06T12:00:00.000Z",
        pidCanStillOwnRun: () => false,
        runtimeAbsent: () => Promise.resolve(true),
      });
      expect(refusal, name).toMatchObject({
        reason: "missing-runtime-identity",
        status: "refused",
      });

      let message = "";
      try {
        await reservePairedLaunch(
          makeOptions(),
          fixture.binding,
          fakeDeps(fixture.home, world)
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, name).toContain("launch conflict: run 80");
      expect(message, name).toContain("it needs an owner decision");
      expect(message, name).not.toContain("loop reconcile stopped-run");
      expect(
        readRunManifest(manifestPath)?.workspaceReleasedAt,
        name
      ).toBeUndefined();
    });
  }
});

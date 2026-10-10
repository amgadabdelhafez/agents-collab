// Process groups as dead-run release evidence (review of b75d3e6a).
//
// A utility worker leads its own process group (it is spawned detached) and
// the bounded commands it runs (verify, test, build) stay in that group with
// their cwd in the workspace; an agent pane's CLI and its tool subprocesses
// run in the pane's process group. Either group can outlive its leader. These
// tests pin that a recorded group is live while ANY member exists (release
// evidence for reconcile, the launch auto-release and startup GC), that a
// teardown and a stale recovery end the whole group after verifying its
// identity (SIGTERM, a bounded grace, SIGKILL), that agent pane processes are
// recorded and ended, that GC writes no handback on less evidence than
// reconcile, that reconcile re-verifies a handback it did not write, and that
// the bridge worker's record never goes missing while a worker is live.
//
// Most tests fake process liveness. The tests named "real" start their own
// detached process groups (sh and sleep only) and end them; no tmux server is
// started or contacted anywhere in this file.

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  bridgeRuntimeCommandDeps,
  ensureBridgeWorker,
  runBridgeWorker,
} from "../../src/loop/bridge-runtime";
import {
  confirmTeardownRelease,
  type GovernessConfig,
  type GovernessDeps,
  stopGovernessLoop,
} from "../../src/loop/governess";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import {
  defaultPidOwnershipDeps,
  pidCanStillOwnRun,
} from "../../src/loop/pid-ownership";
import {
  defaultStillRecorded,
  type GroupOwnershipProbe,
  groupCanStillOwnRun,
  processGroupAlive,
  type TerminationDeps,
  type TerminationTarget,
  terminateTargets,
} from "../../src/loop/process-group";
import {
  agentPaneIdsOf,
  parsePaneListing,
  readAgentGroupRecords,
  readRunPaneProcessRecords,
  recordAgentDescendantGroups,
  recordRunPaneProcesses,
} from "../../src/loop/run-pane-processes";
import {
  cleanupRunOwnedProcesses,
  collectRunAgentGroups,
  gcAbandonedRunProcesses,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  reconcileLegacyStoppedRun,
  resolveRepoId,
  resolveStorageRoot,
  writeRunManifest,
} from "../../src/loop/run-state";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import type { TmuxEndpointState, TmuxTarget } from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";
import { UTILITY_WORKER_SUBCOMMAND } from "../../src/loop/utility-constants";
import {
  processPendingUtilityRoutes,
  utilityWorkerTerminationInternals,
} from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const SOCKET = "/tmp/ls-process-groups/run.sock";
const CREATED_AT = "2026-10-05T20:00:00.000Z";
const UPDATED_AT = "2026-10-05T21:00:00.000Z";
const CLAIMED_AT = "2026-10-05T20:30:00.000Z";
const NOW = "2026-10-06T12:00:00.000Z";
const WORKER = 91_100;
const PANE_PGID = 91_200;

const originalCleanupDeps = { ...runProcessCleanupInternals.deps };
const originalTermination = { ...utilityWorkerTerminationInternals };
const originalBridgeDeps = { ...bridgeRuntimeCommandDeps };
afterEach(() => {
  Object.assign(runProcessCleanupInternals.deps, originalCleanupDeps);
  Object.assign(utilityWorkerTerminationInternals, originalTermination);
  Object.assign(bridgeRuntimeCommandDeps, originalBridgeDeps);
});

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
  liveGroups: Set<number>;
  livePids: Set<number>;
  logs: string[];
  startedAt: Map<number, number>;
}

const newWorld = (live: number[] = [], groups: number[] = []): World => ({
  liveGroups: new Set(groups),
  livePids: new Set(live),
  logs: [],
  startedAt: new Map(),
});

const probeOf = (world: World): GroupOwnershipProbe => ({
  isPidAlive: (pid) => world.livePids.has(pid),
  pidStartedAt: (pid) => world.startedAt.get(pid),
  processGroupAlive: (pgid) => world.liveGroups.has(pgid),
});

// The recorded socket's file is gone and its session cannot answer: the
// runtime is positively absent, so only process evidence can block.
const fakeDeps = (home: string, world: World) => ({
  endpointState: (target: TmuxTarget | undefined): TmuxEndpointState =>
    target ? "absent" : "unknown",
  env: {} as Record<string, string | undefined>,
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
  pidStartedAt: (pid: number) => world.startedAt.get(pid),
  platform: "darwin",
  processGroupAlive: (pgid: number) => world.liveGroups.has(pgid),
  tmuxLiveness: (): "unknown" => "unknown",
  uid: 501,
});

interface Fixture {
  binding: LaunchWorkspaceBinding;
  home: string;
  repoDir: string;
  root: string;
}

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "loop-groups-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-groups-home-"));
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

/** A dead stopped run: its own pids are not alive and its socket is gone. */
const writeRun = (
  fixture: Fixture,
  fields: Record<string, unknown> = {}
): { manifestPath: string; runDir: string } => {
  const runDir = join(fixture.repoDir, "91");
  mkdirSync(runDir, { recursive: true });
  const base = createRunManifest(
    {
      cwd: fixture.root,
      mode: "paired",
      pid: 91_001,
      repoId: fixture.binding.repoId,
      runId: "91",
      state: "stopped",
      workspaceBinding: fixture.binding,
    },
    CREATED_AT
  );
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...base,
        createdAt: CREATED_AT,
        state: "stopped",
        status: "stopped",
        tmuxPaneGoverness: "%3",
        tmuxPaneLeft: "%1",
        tmuxPaneRight: "%2",
        tmuxSession: "groups-loop-91",
        tmuxSocket: SOCKET,
        updatedAt: UPDATED_AT,
        ...fields,
      },
      null,
      2
    )}\n`
  );
  return { manifestPath, runDir };
};

/** A utility job routed at epoch 1 and claimed by `workerPid`. */
const writeClaimedJob = (
  runDir: string,
  jobId: string,
  workerPid: number,
  claimedAt = CLAIMED_AT,
  epoch = 1
): void => {
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    createdAt: CREATED_AT,
    id: jobId,
    kind: "inspect",
    objective: `Inspect the worker configuration for ${jobId}`,
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, epoch);
  transitionUtilityJob(runDir, jobId, "routed-utility", {
    at: CREATED_AT,
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: epoch,
  });
  claimUtilityJob(runDir, epoch, {
    at: claimedAt,
    jobId,
    workerId: `utility-${workerPid}`,
    workerPid,
  });
  transitionUtilityJob(runDir, jobId, "running", { at: claimedAt });
};

/** An agent pane record, as the launch writes it. */
const writePaneRecord = (
  runDir: string,
  paneId: string,
  pid: number,
  pgid = pid
): void => {
  recordRunPaneProcesses({
    agentPaneIds: [paneId],
    now: () => UPDATED_AT,
    panes: [{ paneId, pid }],
    pgidOf: () => pgid,
    runDir,
    session: "groups-loop-91",
  });
};

const runDirs = (repoDir: string): string[] =>
  readdirSync(repoDir)
    .filter((entry) => !entry.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const expectBlocked = async (
  fixture: Fixture,
  world: World,
  manifestPath: string,
  message: string | RegExp,
  name?: string
) => {
  const before = readFileSync(manifestPath);
  const dirs = runDirs(fixture.repoDir);
  let error: unknown;
  try {
    await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
  } catch (caught) {
    error = caught;
  }
  expect(error, name).toBeInstanceOf(Error);
  expect((error as Error).message, name).toMatch(message);
  expect(readFileSync(manifestPath).equals(before), name).toBe(true);
  expect(runDirs(fixture.repoDir), name).toEqual(dirs);
};

const expectReleased = async (
  fixture: Fixture,
  world: World,
  manifestPath: string,
  name?: string
) => {
  const claim = await reservePairedLaunch(
    makeOptions(),
    fixture.binding,
    fakeDeps(fixture.home, world)
  );
  expect(claim.storage.runId, name).toBe("92");
  expect(readRunManifest(manifestPath)?.workspaceReleasedAt, name).toBe(NOW);
};

const at = (iso: string): number => Date.parse(iso);

// --- The group rule ------------------------------------------------------------

test("a group is live while any member exists after its leader is gone, and a provably later leader is not it", () => {
  const reference = CLAIMED_AT;
  const cases: [string, World, boolean][] = [
    ["leader alive, started before the reference", newWorld([7001]), true],
    ["leader gone, a member remains", newWorld([], [7001]), true],
    ["leader gone, group empty", newWorld(), false],
  ];
  const reused = newWorld([7001], [7001]);
  reused.startedAt.set(7001, at("2026-10-05T20:31:00.000Z"));
  cases.push(["leader id held by a provably later process", reused, false]);
  const atReference = newWorld([7001]);
  atReference.startedAt.set(7001, at(reference));
  cases.push(["a leader that started at the reference", atReference, true]);
  for (const [name, world, live] of cases) {
    expect(groupCanStillOwnRun(7001, reference, probeOf(world)), name).toBe(
      live
    );
  }
  // Ids that address every process or the caller's own group are never
  // treated as a recorded group, whatever the probe says.
  for (const pgid of [0, 1, -5]) {
    expect(
      groupCanStillOwnRun(pgid, reference, probeOf(newWorld([pgid], [pgid])))
    ).toBe(false);
  }
});

// --- Release evidence: utility worker groups ----------------------------------

test("a utility worker that is gone keeps a dead run owning while a member of its process group remains", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    await expectBlocked(
      fixture,
      newWorld([], [WORKER]),
      manifestPath,
      `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER} (or a member of its process group)`
    );
  });
  // Control: the same run with the group empty is released.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    await expectReleased(fixture, newWorld(), manifestPath);
  });
  // A provably later process that holds the worker's pid and leads a group
  // of its own is not the worker's group.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    const world = newWorld([WORKER], [WORKER]);
    world.startedAt.set(WORKER, at("2026-10-06T08:00:00.000Z"));
    await expectReleased(fixture, world, manifestPath, "reused leader");
  });
});

test("a run that already recorded its handback still conflicts while its worker's group has a member", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture, {
      workspaceReleasedAt: UPDATED_AT,
    });
    writeClaimedJob(runDir, "job-1", WORKER);
    await expectBlocked(
      fixture,
      newWorld([], [WORKER]),
      manifestPath,
      `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER} (or a member of its process group)`
    );
    // Control: the group is gone and the earlier handback stands.
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, newWorld())
    );
    expect(claim.storage.runId).toBe("92");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(UPDATED_AT);
  });
});

test("teardown confirmation and reconcile judge a utility worker's group, not its pid alone", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    const world = newWorld([], [WORKER]);
    const sleeps: number[] = [];
    const result = await confirmTeardownRelease(manifestPath, "91", {
      attempts: 3,
      groupCanStillOwnRun: (pgid, reference) =>
        groupCanStillOwnRun(pgid, reference, probeOf(world)),
      now: () => "2026-10-06T11:00:01.000Z",
      pidCanStillOwnRun: (pid, reference) =>
        pidCanStillOwnRun(pid, reference, probeOf(world)),
      retryMs: 300,
      runtimeAbsent: () => Promise.resolve(true),
      sleep: (ms) => {
        sleeps.push(ms);
        // The bounded command the teardown signalled exits while it waits.
        world.liveGroups.delete(WORKER);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({
      detail: "changed at 2026-10-06T11:00:01.000Z",
      released: true,
    });
    expect(sleeps).toEqual([300]);
  });
});

// --- Release evidence: agent pane groups --------------------------------------

test("an agent pane's process group keeps a dead run owning until its last member is gone", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writePaneRecord(runDir, "%1", PANE_PGID);
    await expectBlocked(
      fixture,
      newWorld([], [PANE_PGID]),
      manifestPath,
      `recorded-process-may-be-live: run-processes/pane-1-${PANE_PGID}.json pid ${PANE_PGID} (or a member of its process group)`
    );
    await expectBlocked(
      fixture,
      newWorld([PANE_PGID]),
      manifestPath,
      "pane-1-",
      "the pane process itself"
    );
    await expectReleased(fixture, newWorld(), manifestPath, "group gone");
  });
  // The record's GROUP is the evidence, not its pane pid: a pane process that
  // `ps` placed in another group is judged by that group.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writePaneRecord(runDir, "%2", 91_777, PANE_PGID);
    await expectBlocked(
      fixture,
      newWorld([], [PANE_PGID]),
      manifestPath,
      `run-processes/pane-2-91777.json pid ${PANE_PGID} (or a member of its process group)`
    );
  });
});

test("the group of an agent CLI's tool subprocess keeps a dead run owning until its last member is gone", async () => {
  // Claude Code runs each Bash tool shell as a session leader, and Codex each
  // exec command in a group of its own: outside the pane group. Recorded by a
  // snapshot while the CLI was its parent, the group is release evidence for
  // the launch auto-release like any other recorded group.
  const TOOL_PGID = 91_301;
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writePaneRecord(runDir, "%1", PANE_PGID);
    recordAgentDescendantGroups({
      groupAlive: () => true,
      now: () => UPDATED_AT,
      runDir,
      table: [
        { pgid: PANE_PGID, pid: PANE_PGID, ppid: 1, startedAtMs: 0 },
        { pgid: TOOL_PGID, pid: TOOL_PGID, ppid: PANE_PGID, startedAtMs: 0 },
      ],
    });
    // The pane group is gone (the session kill ended the CLI); the tool's
    // group, reparented, lives on.
    await expectBlocked(
      fixture,
      newWorld([], [TOOL_PGID]),
      manifestPath,
      `recorded-process-may-be-live: run-processes/agent-group-${TOOL_PGID}.json pid ${TOOL_PGID} (or a member of its process group)`
    );
    await expectReleased(fixture, newWorld(), manifestPath, "group gone");
  });
  // A descendant group record that names no valid group is unreadable
  // evidence, never absence.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    mkdirSync(join(runDir, "run-processes"), { recursive: true });
    writeFileSync(
      join(runDir, "run-processes", "agent-group-1.json"),
      `${JSON.stringify({
        kind: "agent-descendant-group",
        paneId: "%1",
        pgid: 1,
        recordedAt: UPDATED_AT,
        runDir,
      })}\n`
    );
    await expectBlocked(
      fixture,
      newWorld(),
      manifestPath,
      "recorded-process-evidence-unreadable: run-processes/agent-group-1.json names no valid pid"
    );
  });
});

test("a pane record that names no valid process group blocks release as unreadable", async () => {
  for (const [name, record] of [
    ["group id 1", { pgid: 1 }],
    ["no group id", { pgid: undefined }],
    ["negative group id", { pgid: -4 }],
  ] as const) {
    await withFixture(async (fixture) => {
      const { manifestPath, runDir } = writeRun(fixture);
      mkdirSync(join(runDir, "run-processes"), { recursive: true });
      writeFileSync(
        join(runDir, "run-processes", "pane-1-777.json"),
        `${JSON.stringify({
          kind: "agent-pane",
          paneId: "%1",
          pid: 777,
          recordedAt: UPDATED_AT,
          runDir,
          session: "groups-loop-91",
          ...record,
        })}\n`
      );
      await expectBlocked(
        fixture,
        newWorld(),
        manifestPath,
        "recorded-process-evidence-unreadable: run-processes/pane-1-777.json names no valid pid",
        name
      );
    });
  }
});

// --- Pane records -------------------------------------------------------------

test("only the run's agent panes are recorded, never the governess pane, once per pane process", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-pane-records-"));
  try {
    const panes = parsePaneListing(
      ["%1 501", "%2 502", "%3 503", "%9 509", "garbage", "%4 x", ""].join("\n")
    );
    expect(panes).toEqual([
      { paneId: "%1", pid: 501 },
      { paneId: "%2", pid: 502 },
      { paneId: "%3", pid: 503 },
      { paneId: "%9", pid: 509 },
    ]);
    const agentPanes = agentPaneIdsOf({
      tmuxPaneGoverness: "%3",
      tmuxPaneLeft: "%1",
      tmuxPaneRecon: ["%3"],
      tmuxPaneRight: "%2",
    });
    expect(agentPanes).toEqual(["%1", "%2"]);
    const pgids = new Map([[501, 501]]);
    const records = recordRunPaneProcesses({
      agentPaneIds: agentPanes,
      now: () => UPDATED_AT,
      panes,
      // `ps` cannot say for 502: the pane process leads its own group.
      pgidOf: (pid) => pgids.get(pid),
      runDir,
      session: "groups-loop-91",
    });
    expect(records.map((record) => [record.paneId, record.pgid])).toEqual([
      ["%1", 501],
      ["%2", 502],
    ]);
    expect(readdirSync(join(runDir, "run-processes")).sort()).toEqual([
      "pane-1-501.json",
      "pane-2-502.json",
    ]);
    // No temporary file is left anywhere in the run directory.
    expect(readdirSync(runDir).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
    // Recording again changes nothing; a respawned pane gets its own record
    // beside the old one, so a survivor of the old process stays tracked.
    recordRunPaneProcesses({
      agentPaneIds: agentPanes,
      now: () => NOW,
      panes: [
        { paneId: "%1", pid: 501 },
        { paneId: "%2", pid: 602 },
      ],
      pgidOf: (pid) => pid,
      runDir,
      session: "groups-loop-91",
    });
    expect(
      readRunPaneProcessRecords(runDir).map((record) => [
        record.paneId,
        record.pid,
        record.recordedAt,
      ])
    ).toEqual([
      ["%1", 501, UPDATED_AT],
      ["%2", 502, UPDATED_AT],
      ["%2", 602, NOW],
    ]);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

// --- Teardown cleanup ---------------------------------------------------------

const workerCommand = (runDir: string, epoch: number, jobId: string) =>
  `/Users/me/.local/bin/loop ${UTILITY_WORKER_SUBCOMMAND} ${runDir} ${epoch} ${jobId}`;

test("teardown hands every verified worker group to the post-kill termination and never signals an orphaned group", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-group-cleanup-"));
  try {
    writeClaimedJob(runDir, "job-a", 5101);
    writeClaimedJob(runDir, "job-b", 5102);
    writeClaimedJob(runDir, "job-c", 5103);
    const signals: string[] = [];
    const deps = runProcessCleanupInternals.deps;
    // 5101 leads its group; 5102 leads none; 5103 is gone but a bounded
    // command of its group is still running.
    deps.pidAlive = (pid) => pid === 5101 || pid === 5102;
    deps.processGroupAlive = (pgid) => pgid === 5101 || pgid === 5103;
    const commands: Record<number, string> = {
      5101: workerCommand(runDir, 1, "job-a"),
      5102: workerCommand(runDir, 1, "job-b"),
    };
    deps.commandForPid = (pid) => commands[pid];
    deps.now = () => NOW;
    deps.signal = (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      if (pid === -5102) {
        throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      }
    };
    const result = cleanupRunOwnedProcesses(runDir, undefined);
    expect(signals).toEqual(["-5101:SIGTERM", "-5102:SIGTERM", "5102:SIGTERM"]);
    // Each target carries the instant it was identified at and the worker
    // identity, so every later signal round re-verifies it.
    expect(result.groups).toEqual([
      {
        id: 5101,
        identity: { epoch: 1, jobId: "job-a", runDir },
        kind: "group",
        reference: NOW,
        source: "utility job job-a worker",
      },
      {
        id: 5102,
        identity: { epoch: 1, jobId: "job-b", runDir },
        kind: "process",
        reference: NOW,
        source: "utility job job-b worker",
      },
    ]);
    expect(result.skipped).toEqual([
      { pid: 5103, reason: "utility-worker-group-orphaned" },
    ]);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown records the agent panes of its own session and their descendants' groups, and never targets its own group", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-pane-cleanup-"));
  try {
    const manifest = {
      ...createRunManifest({
        cwd: "/repo",
        mode: "paired",
        pid: 1,
        repoId: "repo",
        runId: "91",
      }),
      tmuxPaneGoverness: "%3",
      tmuxPaneLeft: "%1",
      tmuxPaneRecon: ["%5"],
      tmuxPaneRight: "%2",
      tmuxSession: "groups-loop-91",
    };
    // A record from the launch for a pane process that has since gone from
    // the session while a member of its group (4011, there at the record)
    // lives on: still provably that group.
    writePaneRecord(runDir, "%1", 401);
    // Another old pane record whose group id is now held only by a process
    // started after the record: not provably the recorded group.
    writePaneRecord(runDir, "%2", 402);
    const deps = runProcessCleanupInternals.deps;
    const listedFor: string[] = [];
    deps.listRunPanes = (dir) => {
      listedFor.push(dir);
      return [
        { paneId: "%1", pid: 501 },
        { paneId: "%2", pid: 502 },
        { paneId: "%3", pid: 503 },
        { paneId: "%5", pid: 505 },
      ];
    };
    const early = at(CREATED_AT);
    deps.now = () => NOW;
    deps.pgidOf = (pid) => pid;
    deps.ownProcessGroup = () => 505;
    deps.processGroupAlive = () => {
      throw new Error("the snapshot, not kill(0), says which groups exist");
    };
    // Pane %1's CLI (501) runs a Bash tool shell that leads its own group
    // (601, as Claude Code does) with a build in it (602); pane %2's CLI (502)
    // runs an exec command in a group of its own (701, as Codex does). 900 is
    // unrelated.
    deps.processTable = () => [
      { pgid: 401, pid: 4011, ppid: 1, startedAtMs: early },
      { pgid: 402, pid: 4021, ppid: 1, startedAtMs: at(NOW) - 1000 },
      { pgid: 501, pid: 501, ppid: 1, startedAtMs: early },
      { pgid: 502, pid: 502, ppid: 1, startedAtMs: early },
      { pgid: 503, pid: 503, ppid: 1, startedAtMs: early },
      { pgid: 505, pid: 505, ppid: 1, startedAtMs: early },
      { pgid: 601, pid: 601, ppid: 501, startedAtMs: early },
      { pgid: 601, pid: 602, ppid: 601, startedAtMs: early },
      { pgid: 701, pid: 701, ppid: 502, startedAtMs: early },
      { pgid: 900, pid: 900, ppid: 1, startedAtMs: early },
    ];
    deps.signal = () => {
      throw new Error("agent groups are not signalled before the session kill");
    };
    // The worker cleanup (before the beat close) no longer lists panes.
    cleanupRunOwnedProcesses(runDir, manifest);
    expect(listedFor).toEqual([]);
    const result = collectRunAgentGroups(runDir, manifest);
    expect(listedFor).toEqual([runDir]);
    expect(result.groups).toEqual([
      { id: 401, kind: "group", reference: NOW, source: "agent pane %1" },
      { id: 501, kind: "group", reference: NOW, source: "agent pane %1" },
      { id: 502, kind: "group", reference: NOW, source: "agent pane %2" },
      {
        id: 601,
        kind: "group",
        ownership: "inferred",
        reference: NOW,
        source: "agent %1 descendant",
      },
      {
        id: 701,
        kind: "group",
        ownership: "inferred",
        reference: NOW,
        source: "agent %2 descendant",
      },
    ]);
    expect(result.skipped).toEqual([
      { pid: 402, reason: "agent-group-unverified: agent pane %2" },
      { pid: 505, reason: "own-process-group" },
    ]);
    expect(
      readRunPaneProcessRecords(runDir)
        .map((record) => `${record.paneId}:${record.pid}`)
        .sort()
    ).toEqual(["%1:401", "%1:501", "%2:402", "%2:502", "%5:505"]);
    expect(readAgentGroupRecords(runDir).map((record) => record.pgid)).toEqual([
      601, 701,
    ]);
    // Without a process table nothing is targeted (and nothing is lost: the
    // records stay release evidence).
    deps.processTable = () => undefined;
    expect(collectRunAgentGroups(runDir, manifest)).toEqual({
      killed: [],
      skipped: [{ pid: 0, reason: "process-table-unavailable" }],
    });
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

const teardownConfig = (runDir: string): GovernessConfig =>
  ({
    agents: [],
    epoch: 1,
    logFile: join(runDir, "governess.jsonl"),
    manifestPath: join(runDir, "manifest.json"),
    runDir,
    runId: "91",
    session: "groups-loop-91",
  }) as unknown as GovernessConfig;

const teardownDeps = (
  events: string[],
  overrides: Partial<GovernessDeps>
): GovernessDeps =>
  ({
    appendLog: (_file: string, record: unknown) => {
      events.push(`log:${(record as { event: string }).event}`);
    },
    cleanupRunProcesses: () => {
      events.push("cleanup");
      return {
        groups: [
          { id: 5101, kind: "group", source: "utility job job-a worker" },
        ],
        killed: [5101],
        skipped: [],
      };
    },
    collectAgentGroups: () => {
      events.push("collect-agent-groups");
      return {
        groups: [
          { id: 501, kind: "group", reference: NOW, source: "agent pane %1" },
          {
            id: 601,
            kind: "group",
            reference: NOW,
            source: "agent %1 descendant",
          },
        ],
        killed: [],
        skipped: [],
      };
    },
    fenceCurrent: () => true,
    killSession: () => {
      events.push("kill-session");
    },
    markRunStopped: () => {
      events.push("stopped");
    },
    now: () => Date.parse(NOW),
    releaseWorkspaceAfterTeardown: () => {
      events.push("release");
      return Promise.resolve({ detail: "changed", released: true });
    },
    terminateRunProcessGroups: (
      _config: GovernessConfig,
      targets: readonly TerminationTarget[]
    ) => {
      events.push(`terminate:${targets.map((target) => target.id).join(",")}`);
      return Promise.resolve({
        exited: [],
        failed: [],
        killed: [],
        survivors: [],
      });
    },
    ...overrides,
  }) as unknown as GovernessDeps;

test("teardown ends the verified groups after the session kill and before the handback", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-group-teardown-"));
  try {
    const events: string[] = [];
    await stopGovernessLoop(
      teardownConfig(runDir),
      teardownDeps(events, {}),
      "user requested teardown"
    );
    expect(events.filter((event) => !event.startsWith("log:exit"))).toEqual([
      "stopped",
      "cleanup",
      "log:run-process-cleanup",
      "collect-agent-groups",
      "log:agent-groups-collected",
      "kill-session",
      "terminate:5101,501,601",
      "log:run-process-groups-ended",
      "release",
      "log:workspace-released",
    ]);
    // With a Temporal journal the agent groups are collected after the beat
    // close, right before the kill, so a tool started meanwhile is seen.
    const temporal: string[] = [];
    await stopGovernessLoop(
      {
        ...teardownConfig(runDir),
        journalTemporal: {},
      } as unknown as GovernessConfig,
      teardownDeps(temporal, {
        closeBeatWorkflow: () => {
          temporal.push("beat-close");
          return Promise.resolve(undefined);
        },
      }),
      "user requested teardown"
    );
    expect(temporal.filter((event) => !event.startsWith("log:"))).toEqual([
      "stopped",
      "cleanup",
      "beat-close",
      "collect-agent-groups",
      "kill-session",
      "terminate:5101,501,601",
      "release",
    ]);
    // A kill that was not confirmed ends nothing and attempts no handback.
    const failed: string[] = [];
    await stopGovernessLoop(
      teardownConfig(runDir),
      teardownDeps(failed, {
        killSession: () => {
          failed.push("kill-session");
          throw new Error("tmux control unavailable");
        },
      }),
      "user requested teardown"
    );
    expect(failed.some((event) => event.startsWith("terminate"))).toBe(false);
    expect(failed).not.toContain("release");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

// --- Termination --------------------------------------------------------------

const fakeTermination = (
  world: World,
  overrides: Partial<TerminationDeps> = {}
): TerminationDeps & { signals: string[] } => {
  let clock = 0;
  const signals: string[] = [];
  return {
    graceMs: 1000,
    isPidAlive: (pid) => world.livePids.has(pid),
    killWaitMs: 500,
    nowMs: () => clock,
    pollMs: 100,
    processGroupAlive: (pgid) => world.liveGroups.has(pgid),
    signal: (id, signal) => {
      signals.push(`${id}:${signal}`);
      const group = id < 0;
      const target = Math.abs(id);
      const alive = group
        ? world.liveGroups.has(target)
        : world.livePids.has(target);
      if (!alive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL") {
        world.liveGroups.delete(target);
        world.livePids.delete(target);
      }
    },
    signals,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
};

test("termination sends SIGTERM, waits a bounded grace, then SIGKILLs only what is still alive", async () => {
  // 6001 ignores SIGTERM; 6002 exits on it; 6003 is already gone.
  const world = newWorld([], [6001, 6002]);
  const deps = fakeTermination(world);
  const signal = deps.signal;
  deps.signal = (id, sig) => {
    signal(id, sig);
    if (id === -6002 && sig === "SIGTERM") {
      world.liveGroups.delete(6002);
    }
  };
  const result = await terminateTargets(
    [
      { id: 6001, kind: "group", source: "a" },
      { id: 6002, kind: "group", source: "b" },
      { id: 6003, kind: "group", source: "c" },
      { id: 6001, kind: "group", source: "a again" },
      // Never signalled: these ids address every process or our own group.
      { id: 1, kind: "group", source: "init" },
      { id: 0, kind: "group", source: "self" },
    ],
    deps
  );
  expect(deps.signals).toEqual([
    "-6001:SIGTERM",
    "-6002:SIGTERM",
    "-6003:SIGTERM",
    "-6001:SIGKILL",
  ]);
  expect(result).toEqual({
    exited: ["b process group 6002", "c process group 6003"],
    failed: [],
    killed: ["a process group 6001"],
    survivors: [],
  });
});

test("termination reports a survivor and a signal failure instead of hiding them", async () => {
  const world = newWorld([7001], [7002]);
  const deps = fakeTermination(world, {
    signal: (id) => {
      if (id === -7002) {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }
      // 7001 survives even SIGKILL (uninterruptible sleep).
    },
  });
  const result = await terminateTargets(
    [
      { id: 7001, kind: "process", source: "stuck" },
      { id: 7002, kind: "group", source: "foreign" },
    ],
    deps
  );
  expect(result.survivors).toEqual([
    "stuck pid 7001",
    "foreign process group 7002",
  ]);
  expect(result.failed).toEqual([
    { reason: "signal-failed:EPERM", target: "foreign process group 7002" },
    { reason: "signal-failed:EPERM", target: "foreign process group 7002" },
  ]);
});

// --- Stale recovery -----------------------------------------------------------

const staleRun = (): { repoRoot: string; runDir: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-stale-group-"));
  const runDir = join(repoRoot, ".loop", "runs", "stale-group-run");
  mkdirSync(runDir, { recursive: true });
  return { repoRoot, runDir };
};

const writeTimedOutJob = (runDir: string, jobId: string, workerPid: number) => {
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: jobId,
    kind: "inspect",
    // Distinct per job: identical requests are deduplicated.
    objective: `Inspect one file for ${jobId}`,
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 22);
  transitionUtilityJob(runDir, jobId, "routed-utility", { routeEpoch: 22 });
  claimUtilityJob(runDir, 22, {
    at: "2026-07-26T16:00:00.000Z",
    jobId,
    workerPid,
  });
  transitionUtilityJob(runDir, jobId, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
};

const processStaleJobs = (repoRoot: string, runDir: string) =>
  processPendingUtilityRoutes(
    { currentDriver: "claude", epoch: 22, peer: "codex", repoRoot, runDir },
    { LOOP_UTILITY_MAX_RUNTIME_MS: "1000" },
    {
      isWorkerAlive: () => true,
      now: () => Date.parse("2026-07-26T16:00:05.000Z"),
    }
  );

test("stale recovery ends a timed-out worker's whole process group, and only an identified worker's", async () => {
  const { repoRoot, runDir } = staleRun();
  try {
    writeTimedOutJob(runDir, "timed-out", 4444);
    writeTimedOutJob(runDir, "recycled", 4445);
    const world = newWorld([4444, 4445], [4444, 4445]);
    const deps = fakeTermination(world);
    // The identified group carries the identification instant, so it is
    // re-identified before the SIGKILL that follows the grace.
    const reidentified: string[] = [];
    deps.stillRecorded = (targets) => {
      reidentified.push(
        ...targets.map((target) => `${target.id}@${target.reference}`)
      );
      return new Set(targets.map((target) => `${target.kind}:${target.id}`));
    };
    utilityWorkerTerminationInternals.terminationDeps = () => deps;
    utilityWorkerTerminationInternals.commandForPid = (pid) =>
      pid === 4444
        ? workerCommand(runDir, 22, "timed-out")
        : "/usr/bin/vim notes.txt";
    await processStaleJobs(repoRoot, runDir);
    // The identified worker's group is ended, escalating past the grace; the
    // recycled pid running something else is never signalled.
    expect(deps.signals).toEqual(["-4444:SIGTERM", "-4444:SIGKILL"]);
    // The fake clock starts at 0.
    const identifiedAt = new Date(0).toISOString();
    expect(reidentified).toEqual([
      `4444@${identifiedAt}`,
      `4444@${identifiedAt}`,
    ]);
    expect(world.liveGroups.has(4445)).toBe(true);
    for (const jobId of ["timed-out", "recycled"]) {
      expect(readUtilityJob(runDir, jobId)?.state, jobId).toBe("failed");
    }
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("stale recovery re-checks the worker's exact run, epoch and job command on each round's snapshot, right before the SIGTERM and right before the SIGKILL", async () => {
  // `round` counts the snapshots taken; `commandAt(round)` is the leader's
  // command line in that snapshot.
  const run = async (commandAt: (round: number, runDir: string) => string) => {
    const { repoRoot, runDir } = staleRun();
    try {
      writeTimedOutJob(runDir, "timed-out", 4444);
      const world = newWorld([4444], [4444]);
      let round = 0;
      const deps = fakeTermination(world, {
        snapshot: () => {
          round += 1;
          const command = commandAt(round, runDir);
          return {
            commands: () => new Map([[4444, command]]),
            table: [{ pgid: 4444, pid: 4444, ppid: 1, startedAtMs: -1 }],
          };
        },
        // The production re-identification, on the round's snapshot.
        stillRecorded: defaultStillRecorded,
      });
      utilityWorkerTerminationInternals.terminationDeps = () => deps;
      // The identification before the first round sees the worker.
      utilityWorkerTerminationInternals.commandForPid = () =>
        workerCommand(runDir, 22, "timed-out");
      await processStaleJobs(repoRoot, runDir);
      return deps.signals;
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  };
  // Still the worker in both rounds: SIGTERM, then SIGKILL.
  expect(
    await run((_round, runDir) => workerCommand(runDir, 22, "timed-out"))
  ).toEqual(["-4444:SIGTERM", "-4444:SIGKILL"]);
  // The leader runs something else by the SIGKILL round: no SIGKILL.
  expect(
    await run((round, runDir) =>
      round === 1
        ? workerCommand(runDir, 22, "timed-out")
        : "/usr/bin/vim notes.txt"
    )
  ).toEqual(["-4444:SIGTERM"]);
  // Another epoch's or job's worker by the first round: never signalled.
  expect(
    await run((_round, runDir) => workerCommand(runDir, 23, "timed-out"))
  ).toEqual([]);
  expect(
    await run((_round, runDir) => workerCommand(runDir, 22, "other-job"))
  ).toEqual([]);
});

// --- Startup GC ---------------------------------------------------------------

const writeGcRun = (
  storageRoot: string,
  repoId: string,
  fields: Record<string, unknown> = {}
): string => {
  const runDir = join(storageRoot, repoId, "89");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(join(runDir, "manifest.json"), {
    ...createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 8900,
      repoId,
      runId: "89",
      state: "working",
      tmuxSession: "repo-loop-89",
    }),
    ...fields,
  });
  return runDir;
};

const runGc = (
  storageRoot: string,
  world: World,
  overrides: Parameters<typeof gcAbandonedRunProcesses>[0] = {}
) =>
  gcAbandonedRunProcesses({
    deps: {
      commandForPid: () => undefined,
      listTmuxSessions: () => new Set(),
      listeningPids: () => [],
      pidAlive: (pid) => world.livePids.has(pid),
      pidStartedAt: (pid) => world.startedAt.get(pid),
      processGroupAlive: (pgid) => world.liveGroups.has(pgid),
      runtimeAbsent: () => true,
      signal: () => undefined,
    },
    log: () => undefined,
    repoId: "repo",
    storageRoot,
    ...overrides,
  });

test("startup GC repairs an abandoned run but writes no handback while a recorded group or process may be live", () => {
  const blockers: [string, (runDir: string) => World][] = [
    [
      "a utility worker's group",
      (runDir) => {
        writeClaimedJob(runDir, "job-g", WORKER);
        return newWorld([], [WORKER]);
      },
    ],
    [
      "an agent pane's group",
      (runDir) => {
        writePaneRecord(runDir, "%1", PANE_PGID);
        return newWorld([], [PANE_PGID]);
      },
    ],
    [
      "the bridge worker",
      (runDir) => {
        writeFileSync(
          join(runDir, "bridge-worker.json"),
          `${JSON.stringify({ pid: 8803 })}\n`
        );
        return newWorld([8803]);
      },
    ],
    ["the launch attempt", () => newWorld([8904])],
  ];
  for (const [name, arrange] of blockers) {
    const root = mkdtempSync(join(tmpdir(), "loop-gc-groups-"));
    try {
      const runDir = writeGcRun(root, "repo", { launchAttemptPid: 8904 });
      const world = arrange(runDir);
      const result = runGc(root, world);
      expect(result.cleaned, name).toBe(1);
      const after = readRunManifest(join(runDir, "manifest.json"));
      // Repaired (the launch auto-release judges a failed run on the same
      // full evidence later), but not handed back.
      expect(after?.state, name).toBe("failed");
      expect(after?.workspaceReleasedAt, name).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
  // Control: the same run with nothing live is repaired and handed back.
  const root = mkdtempSync(join(tmpdir(), "loop-gc-groups-"));
  try {
    const runDir = writeGcRun(root, "repo", { launchAttemptPid: 8904 });
    writeClaimedJob(runDir, "job-g", WORKER);
    writePaneRecord(runDir, "%1", PANE_PGID);
    runGc(root, newWorld());
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "failed",
      workspaceReleasedAt: expect.any(String),
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC leaves a never-bound launch active while a recorded process lives, and releases it once none does", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-gc-never-bound-"));
  try {
    const runDir = writeGcRun(root, "repo", {
      state: "submitted",
      tmuxSession: undefined,
    });
    writeClaimedJob(runDir, "job-n", WORKER);
    const manifestPath = join(runDir, "manifest.json");
    runGc(root, newWorld([], [WORKER]));
    expect(readRunManifest(manifestPath)).toMatchObject({ state: "submitted" });
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBeUndefined();
    // Still active, so the next GC judges it again.
    runGc(root, newWorld());
    expect(readRunManifest(manifestPath)).toMatchObject({
      state: "failed",
      workspaceReleaseKind: "abandoned-never-bound",
      workspaceReleasedAt: expect.any(String),
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC keeps an app-server it signalled recorded while it is still exiting", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-gc-app-server-"));
  try {
    const runDir = writeGcRun(root, "repo", {
      codexAppServerPid: 8801,
      codexRemoteUrl: "ws://127.0.0.1:4500",
    });
    const world = newWorld([8801]);
    const signals: number[] = [];
    runGc(root, world, {
      deps: {
        commandForPid: (pid) =>
          pid === 8801
            ? "codex app-server --listen ws://127.0.0.1:4500"
            : undefined,
        listTmuxSessions: () => new Set(),
        listeningPids: (port) => (port === 4500 ? [8801] : []),
        pidAlive: (pid) => world.livePids.has(pid),
        pidStartedAt: () => undefined,
        processGroupAlive: () => false,
        // The app-server started before the run's manifest recorded it.
        processTable: () => [
          { pgid: 8801, pid: 8801, ppid: 1, startedAtMs: 0 },
        ],
        runtimeAbsent: () => true,
        signal: (pid) => {
          signals.push(pid);
        },
      },
    });
    expect(signals).toEqual([-8801]);
    const after = readRunManifest(join(runDir, "manifest.json"));
    expect(after?.codexAppServerPid).toBe(8801);
    expect(after?.workspaceReleasedAt).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- Reconcile re-verifies a handback it did not write -------------------------

test("reconcile re-verifies a recorded handback on the full evidence before answering already-released", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture, {
      workspaceReleasedAt: UPDATED_AT,
    });
    writeClaimedJob(runDir, "job-1", WORKER);
    const reconcile = (world: World, runtimeAbsent = true) => {
      const probes: string[] = [];
      return reconcileLegacyStoppedRun(manifestPath, "91", {
        groupCanStillOwnRun: (pgid, reference) =>
          groupCanStillOwnRun(pgid, reference, probeOf(world)),
        now: () => NOW,
        pidCanStillOwnRun: (pid, reference) =>
          pidCanStillOwnRun(pid, reference, probeOf(world)),
        runtimeAbsent: () => {
          probes.push("runtime");
          return Promise.resolve(runtimeAbsent);
        },
        terminalState: "stopped",
      }).then((result) => ({ probes, result }));
    };
    const before = readFileSync(manifestPath);
    expect((await reconcile(newWorld([], [WORKER]))).result).toEqual({
      reason: `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER} (or a member of its process group)`,
      runId: "91",
      status: "refused",
    });
    expect((await reconcile(newWorld([91_001]))).result).toMatchObject({
      reason: "run-process-may-be-live",
      status: "refused",
    });
    expect((await reconcile(newWorld(), false)).result).toMatchObject({
      reason: "tmux-runtime-not-absent",
      status: "refused",
    });
    expect((await reconcile(newWorld())).result).toEqual({
      runId: "91",
      status: "already-released",
      workspaceReleasedAt: UPDATED_AT,
    });
    // Re-verification never rewrites the manifest.
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
  });
});

test("reconcile accepts GC's never-bound handback without a runtime to probe, but not while a process lives", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath } = writeRun(fixture, {
      tmuxPaneGoverness: undefined,
      tmuxPaneLeft: undefined,
      tmuxPaneRight: undefined,
      tmuxSession: undefined,
      tmuxSocket: undefined,
      workspaceReleaseKind: "abandoned-never-bound",
      workspaceReleasedAt: UPDATED_AT,
    });
    const reconcile = (world: World) =>
      reconcileLegacyStoppedRun(manifestPath, "91", {
        groupCanStillOwnRun: (pgid, reference) =>
          groupCanStillOwnRun(pgid, reference, probeOf(world)),
        now: () => NOW,
        pidCanStillOwnRun: (pid, reference) =>
          pidCanStillOwnRun(pid, reference, probeOf(world)),
        runtimeAbsent: () => {
          throw new Error("a never-bound run has no runtime to probe");
        },
        terminalState: "stopped",
      });
    expect(await reconcile(newWorld())).toEqual({
      runId: "91",
      status: "already-released",
      workspaceReleasedAt: UPDATED_AT,
    });
    expect(await reconcile(newWorld([91_001]))).toMatchObject({
      reason: "run-process-may-be-live",
      status: "refused",
    });
  });
});

// --- Bridge worker record -----------------------------------------------------

test("ensureBridgeWorker keeps the previous record until the new worker's pid replaces it", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-bridge-record-"));
  try {
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const record = join(runDir, "bridge-worker.json");
    writeFileSync(record, '{"pid":45568}\n');
    writeFileSync(
      join(runDir, "manifest.json"),
      `${JSON.stringify({
        codexRemoteUrl: "ws://127.0.0.1:4500",
        codexThreadId: "codex-thread-1",
        createdAt: CREATED_AT,
        cwd: "/repo",
        mode: "paired",
        pid: 1234,
        repoId: "repo-123",
        runId: "8",
        state: "working",
        status: "running",
        updatedAt: CREATED_AT,
      })}\n`
    );
    const seenAtSpawn: string[] = [];
    bridgeRuntimeCommandDeps.commandForPid = () => undefined;
    bridgeRuntimeCommandDeps.spawn = (() => {
      seenAtSpawn.push(
        existsSync(record) ? readFileSync(record, "utf8").trim() : "missing"
      );
      return { pid: 78_787, unref: () => undefined };
    }) as unknown as typeof bridgeRuntimeCommandDeps.spawn;
    expect(ensureBridgeWorker(runDir)).toBe(true);
    // While the spawn is in flight the record names this live spawner, so a
    // release reading it waits; never the previous (dead) worker's pid.
    expect(seenAtSpawn.map((text) => JSON.parse(text))).toEqual([
      { pending: true, pid: process.pid },
    ]);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ pid: 78_787 });
    expect(readdirSync(runDir).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
    // A spawn that starts no worker puts the previous record back.
    writeFileSync(record, '{"pid":45568}\n');
    bridgeRuntimeCommandDeps.spawn = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof bridgeRuntimeCommandDeps.spawn;
    expect(ensureBridgeWorker(runDir)).toBe(false);
    expect(readFileSync(record, "utf8")).toBe('{"pid":45568}\n');
    rmSync(record);
    bridgeRuntimeCommandDeps.spawn = (() => ({
      pid: 0,
    })) as unknown as typeof bridgeRuntimeCommandDeps.spawn;
    expect(ensureBridgeWorker(runDir)).toBe(false);
    expect(existsSync(record)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

const writeBridgeRun = (state: string): { root: string; runDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "loop-bridge-worker-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: CREATED_AT,
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state,
      status: state === "working" ? "running" : state,
      updatedAt: CREATED_AT,
    })}\n`
  );
  return { root, runDir };
};

/** One worker cycle, after which the run turns terminal and the worker exits. */
const oneWorkerCycle = (runDir: string): string[] => {
  const waits: string[] = [];
  bridgeRuntimeCommandDeps.createWorkerWakeSession = (() => ({
    close: () => undefined,
    wait: () => Promise.reject(new Error("unexpected direct wait")),
  })) as unknown as typeof bridgeRuntimeCommandDeps.createWorkerWakeSession;
  bridgeRuntimeCommandDeps.waitForWorkerWake = ((
    _dir: string,
    version: string
  ) => {
    waits.push(version);
    const path = join(runDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      `${JSON.stringify({ ...manifest, state: "stopped", status: "stopped" })}\n`
    );
    return Promise.resolve({ reason: "heartbeat", version });
  }) as unknown as typeof bridgeRuntimeCommandDeps.waitForWorkerWake;
  return waits;
};

test("a bridge worker leaves its record in place when it exits, and starts despite a record naming a gone predecessor", async () => {
  // Exits on a terminal run with its own record kept: it is alive until it
  // exits, and a release reads the record exactly then.
  const own = writeBridgeRun("working");
  try {
    const record = join(own.runDir, "bridge-worker.json");
    writeFileSync(record, `${JSON.stringify({ pid: process.pid })}\n`);
    const waits = oneWorkerCycle(own.runDir);
    await runBridgeWorker(own.runDir);
    expect(waits).toHaveLength(1);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
      pid: process.pid,
    });
  } finally {
    rmSync(own.root, { force: true, recursive: true });
  }
  // The record names a gone process (a predecessor, or a spawner that died
  // before writing the new pid): the new worker runs instead of exiting as if
  // another worker owned the run, and records its own pid, so a live worker
  // is never left unrecorded.
  const fresh = writeBridgeRun("working");
  try {
    const record = join(fresh.runDir, "bridge-worker.json");
    writeFileSync(
      record,
      `${JSON.stringify({ pending: true, pid: 4_000_002 })}\n`
    );
    const waits = oneWorkerCycle(fresh.runDir);
    await runBridgeWorker(fresh.runDir);
    expect(waits).toHaveLength(1);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
      pid: process.pid,
    });
  } finally {
    rmSync(fresh.root, { force: true, recursive: true });
  }
  // A live spawner's pending record is left for the spawner to replace.
  const pending = writeBridgeRun("working");
  try {
    const record = join(pending.runDir, "bridge-worker.json");
    const text = `${JSON.stringify({ pending: true, pid: process.ppid })}\n`;
    writeFileSync(record, text);
    bridgeRuntimeCommandDeps.commandForPid = () => "bun test";
    oneWorkerCycle(pending.runDir);
    await runBridgeWorker(pending.runDir);
    expect(readFileSync(record, "utf8")).toBe(text);
  } finally {
    rmSync(pending.root, { force: true, recursive: true });
  }
  // Control: a live worker of this run owns the record, so this one leaves.
  const owned = writeBridgeRun("working");
  try {
    writeFileSync(
      join(owned.runDir, "bridge-worker.json"),
      `${JSON.stringify({ pid: process.ppid })}\n`
    );
    bridgeRuntimeCommandDeps.commandForPid = (pid: number) =>
      pid === process.ppid ? `loop __bridge-worker ${owned.runDir}` : undefined;
    const waits = oneWorkerCycle(owned.runDir);
    await runBridgeWorker(owned.runDir);
    expect(waits).toHaveLength(0);
  } finally {
    rmSync(owned.root, { force: true, recursive: true });
  }
});

// --- Real process groups ------------------------------------------------------

const readLine = async (
  stream: ReadableStream<Uint8Array>
): Promise<string> => {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return text.trim();
};

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
};

test("real: a utility worker killed alone leaves its bounded command running, and the group blocks release until it ends", async () => {
  await withFixture(async (fixture) => {
    // Pids above the platform's pid range: the real probe finds no process.
    const { manifestPath, runDir } = writeRun(fixture, { pid: 4_000_001 });
    // A detached leader (as a worker is spawned) whose child runs on after
    // the leader is killed alone, as the old stale recovery did.
    const leader = spawn(["/bin/sh", "-c", "sleep 60 & echo $!; wait"], {
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const pgid = leader.pid;
    try {
      const child = Number.parseInt(await readLine(leader.stdout), 10);
      writeClaimedJob(runDir, "job-real", pgid, new Date().toISOString());
      process.kill(pgid, "SIGKILL");
      await leader.exited;
      expect(
        await waitFor(() => !defaultPidOwnershipDeps.isPidAlive(pgid))
      ).toBe(true);
      expect(defaultPidOwnershipDeps.isPidAlive(child)).toBe(true);
      expect(processGroupAlive(pgid)).toBe(true);
      const reconcile = () =>
        reconcileLegacyStoppedRun(manifestPath, "91", {
          groupCanStillOwnRun: (id, reference) =>
            groupCanStillOwnRun(id, reference, defaultPidOwnershipDeps),
          now: () => new Date().toISOString(),
          pidCanStillOwnRun: (id, reference) =>
            pidCanStillOwnRun(id, reference, defaultPidOwnershipDeps),
          runtimeAbsent: () => Promise.resolve(true),
          terminalState: "stopped",
        });
      expect(await reconcile()).toMatchObject({
        reason: expect.stringContaining(
          `utility job job-real worker pid ${pgid} (or a member of its process group)`
        ),
        status: "refused",
      });
      // The release waits for the group: once its last member is gone, the
      // same evidence releases.
      killGroup(pgid);
      expect(await waitFor(() => !processGroupAlive(pgid))).toBe(true);
      expect(await reconcile()).toMatchObject({ status: "changed" });
    } finally {
      killGroup(pgid);
    }
  });
});

test("real: stale recovery ends a worker's group that ignores SIGTERM, bounded commands included", async () => {
  const { repoRoot, runDir } = staleRun();
  const worker = spawn(
    [
      "/bin/sh",
      "-c",
      "trap '' TERM; sleep 60 & echo $!; wait",
      UTILITY_WORKER_SUBCOMMAND,
      runDir,
      "22",
      "real-timed-out",
    ],
    { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" }
  );
  const pgid = worker.pid;
  try {
    const child = Number.parseInt(await readLine(worker.stdout), 10);
    writeTimedOutJob(runDir, "real-timed-out", pgid);
    const started = Date.now();
    utilityWorkerTerminationInternals.terminationDeps = () => ({
      ...originalTermination.terminationDeps(),
      graceMs: 300,
    });
    await processStaleJobs(repoRoot, runDir);
    expect(await waitFor(() => !processGroupAlive(pgid), 2000)).toBe(true);
    expect(defaultPidOwnershipDeps.isPidAlive(child)).toBe(false);
    // SIGTERM was ignored, so the group was ended only after the grace.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(readUtilityJob(runDir, "real-timed-out")?.state).toBe("failed");
  } finally {
    killGroup(pgid);
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

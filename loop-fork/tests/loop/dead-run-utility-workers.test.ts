// Utility workers (Direct, Nanny, Au Pair) are spawned detached with their cwd
// in the run's workspace, and their pid is recorded only in the utility job
// claim. A dead-run release that ignored them could hand the workspace back
// while a worker of the run was still writing in it. These tests pin that a
// claim's worker is release evidence (live or unreadable blocks; dead or
// provably reused does not), that the teardown ends the run's own workers and
// nothing else, that startup GC signals no detached worker, and that a worker
// which claims a job after its run stopped does no work.
//
// As in dead-run-release.test.ts, tmux liveness, the socket endpoint probe,
// and process liveness are fakes: no tmux server is started or contacted, and
// no process is signalled.

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
import { confirmTeardownRelease } from "../../src/loop/governess";
import {
  reservePairedLaunch,
  tmuxRuntimeAbsentForManifestSync,
} from "../../src/loop/launch-reservation";
import {
  cleanupRunOwnedProcesses,
  gcAbandonedRunProcesses,
  registerRunBridgeProcess,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
  UTILITY_TORN_TAIL_GRACE_MS,
  writeRunManifest,
} from "../../src/loop/run-state";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import type { TmuxEndpointState, TmuxTarget } from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";
import { UTILITY_WORKER_SUBCOMMAND } from "../../src/loop/utility-constants";
import { runUtilityWorker } from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const SOCKET = "/tmp/ls-utility-workers/run.sock";
const CREATED_AT = "2026-10-05T20:00:00.000Z";
const UPDATED_AT = "2026-10-05T21:00:00.000Z";
const CLAIMED_AT = "2026-10-05T20:30:00.000Z";
const NOW = "2026-10-06T12:00:00.000Z";
const WORKER = 81_100;

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
  livePids: Set<number>;
  logs: string[];
  startedAt: Map<number, number>;
}

const newWorld = (...live: number[]): World => ({
  livePids: new Set(live),
  logs: [],
  startedAt: new Map(),
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
  // No group outlives its leader here (dead-run-process-groups.test.ts
  // covers groups); never the host's process table.
  processGroupAlive: () => false,
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
  const root = mkdtempSync(join(tmpdir(), "loop-utility-worker-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-utility-worker-home-"));
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
  const runDir = join(fixture.repoDir, "81");
  mkdirSync(runDir, { recursive: true });
  const base = createRunManifest(
    {
      cwd: fixture.root,
      mode: "paired",
      pid: 81_001,
      repoId: fixture.binding.repoId,
      runId: "81",
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
        tmuxSession: "guards-loop-81",
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

type JobEnd = "claimed" | "running" | "failed";

/** A utility job routed at epoch 1 and claimed by `workerPid` at `claimedAt`. */
const writeClaimedJob = (
  runDir: string,
  jobId: string,
  workerPid: number,
  end: JobEnd = "running",
  claimedAt = CLAIMED_AT
): void => {
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    createdAt: CREATED_AT,
    id: jobId,
    kind: "inspect",
    // Distinct per job: identical requests are deduplicated.
    objective: `Inspect the worker configuration for ${jobId}`,
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 1);
  transitionUtilityJob(runDir, jobId, "routed-utility", {
    at: CREATED_AT,
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 1,
  });
  claimUtilityJob(runDir, 1, {
    at: claimedAt,
    jobId,
    workerId: `utility-${workerPid}`,
    workerPid,
  });
  if (end === "running" || end === "failed") {
    transitionUtilityJob(runDir, jobId, "running", { at: claimedAt });
  }
  if (end === "failed") {
    transitionUtilityJob(runDir, jobId, "failed", {
      at: claimedAt,
      result: {
        artifactRefs: [],
        blocker: "runtime limit",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Au Pair job exceeded its runtime limit.",
      },
    });
  }
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
  expect(world.logs, name).toEqual([]);
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
  expect(claim.storage.runId, name).toBe("82");
  expect(readRunManifest(manifestPath)?.workspaceReleasedAt, name).toBe(NOW);
};

const at = (iso: string): number => Date.parse(iso);

// --- Release evidence --------------------------------------------------------

test("a live utility worker of a claimed, running, or already ended job keeps a dead stopped run owning", async () => {
  for (const end of ["claimed", "running", "failed"] as const) {
    await withFixture(async (fixture) => {
      const { manifestPath, runDir } = writeRun(fixture);
      writeClaimedJob(runDir, "job-1", WORKER, end);
      await expectBlocked(
        fixture,
        newWorld(WORKER),
        manifestPath,
        `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER}`,
        end
      );
      expect(
        readRunManifest(manifestPath)?.workspaceReleasedAt
      ).toBeUndefined();
    });
  }
});

test("a dead utility worker, or a live pid that provably started after its claim, is not ownership", async () => {
  // Control: the same run with its worker gone is released.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    await expectReleased(fixture, newWorld(), manifestPath, "dead worker");
  });
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    const world = newWorld(WORKER);
    world.startedAt.set(WORKER, at("2026-10-06T08:00:00.000Z"));
    await expectReleased(fixture, world, manifestPath, "reused pid");
  });
});

test("a live worker pid is judged against its claim instant alone", async () => {
  // Claim AFTER the last manifest update: a pid that started before the claim
  // may still be the worker.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(
      runDir,
      "job-1",
      WORKER,
      "running",
      "2026-10-05T22:00:00.000Z"
    );
    const world = newWorld(WORKER);
    world.startedAt.set(WORKER, at("2026-10-05T21:30:00.000Z"));
    await expectBlocked(
      fixture,
      world,
      manifestPath,
      "utility job job-1 worker",
      "started before a claim later than the update"
    );
  });
  // Claim BEFORE the last manifest update, pid started between the two. The
  // worker wrote its own claim after it started, so a process that started
  // after the claim is provably not it: the run's later update must not turn
  // that recycled pid into ownership.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER, "running", CLAIMED_AT);
    const world = newWorld(WORKER);
    world.startedAt.set(WORKER, at("2026-10-05T20:45:00.000Z"));
    await expectReleased(
      fixture,
      world,
      manifestPath,
      "started after the claim, before the update"
    );
  });
  // The boundary: a process that started at the claim instant may be the
  // worker.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER, "running", CLAIMED_AT);
    const world = newWorld(WORKER);
    world.startedAt.set(WORKER, at(CLAIMED_AT));
    await expectBlocked(
      fixture,
      world,
      manifestPath,
      "utility job job-1 worker",
      "started at the claim instant"
    );
  });
});

test("an already-released run is not re-blocked by a long-ended worker whose pid was recycled", async () => {
  // Released before the claim-time reference existed; the worker of an old
  // job is long gone and an unrelated process that started after its claim,
  // but before the run's release, now holds its pid.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture, {
      workspaceReleasedAt: UPDATED_AT,
    });
    writeClaimedJob(runDir, "job-1", WORKER, "failed", CLAIMED_AT);
    const world = newWorld(WORKER);
    world.startedAt.set(WORKER, at("2026-10-05T20:45:00.000Z"));
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.storage.runId).toBe("82");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(UPDATED_AT);
  });
});

const JOURNAL = (runDir: string) => join(runDir, "utility", "jobs.jsonl");

const ageJournal = (runDir: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  utimesSync(JOURNAL(runDir), when, when);
};

test("an unreadable utility job journal blocks release instead of reading as no workers", async () => {
  // A malformed COMPLETE line is corruption, however old: its ordering and
  // content cannot be trusted.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"interior": broken}\n`
    );
    ageJournal(runDir, 3_600_000);
    await expectBlocked(
      fixture,
      newWorld(),
      manifestPath,
      "recorded-process-evidence-unreadable: utility/jobs.jsonl is unreadable: malformed utility event"
    );
  });
  // A torn FINAL append that is fresh may still be in flight: it may be the
  // claim of a worker that is alive right now.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    await expectBlocked(
      fixture,
      newWorld(),
      manifestPath,
      "recorded-process-evidence-unreadable: utility/jobs.jsonl is unreadable: its final append"
    );
  });
});

test("a torn final append past the in-flight grace is a dead writer's remains, not a block", async () => {
  // Just inside the grace: still blocks.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    ageJournal(runDir, UTILITY_TORN_TAIL_GRACE_MS - 10_000);
    await expectBlocked(
      fixture,
      newWorld(),
      manifestPath,
      "is torn and may still be in flight",
      "inside the grace"
    );
  });
  // Past the grace, with every worker of the complete lines dead: released.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    ageJournal(runDir, UTILITY_TORN_TAIL_GRACE_MS + 10_000);
    await expectReleased(fixture, newWorld(), manifestPath, "past the grace");
  });
  // Past the grace, the complete lines are still evidence: their live worker
  // blocks.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    ageJournal(runDir, UTILITY_TORN_TAIL_GRACE_MS + 10_000);
    await expectBlocked(
      fixture,
      newWorld(WORKER),
      manifestPath,
      `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER}`,
      "complete lines still count"
    );
  });
  // An already-released run whose journal ends torn does not block every new
  // launch in its workspace.
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture, {
      workspaceReleasedAt: UPDATED_AT,
    });
    writeClaimedJob(runDir, "job-1", WORKER, "failed");
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    ageJournal(runDir, UTILITY_TORN_TAIL_GRACE_MS + 10_000);
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, newWorld())
    );
    expect(claim.storage.runId, "already released").toBe("82");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(UPDATED_AT);
  });
});

test("a run that already recorded its handback still conflicts while its utility worker is live", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture, {
      workspaceReleasedAt: "2026-10-05T21:00:00.000Z",
    });
    writeClaimedJob(runDir, "job-1", WORKER);
    await expectBlocked(
      fixture,
      newWorld(WORKER),
      manifestPath,
      `recorded-process-may-be-live: utility job job-1 worker pid ${WORKER}`
    );
    // Control: once the worker is gone the recorded handback is honoured.
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, newWorld())
    );
    expect(claim.storage.runId).toBe("82");
  });
});

test("teardown confirmation waits for a utility worker that is still exiting", async () => {
  await withFixture(async (fixture) => {
    const { manifestPath, runDir } = writeRun(fixture);
    writeClaimedJob(runDir, "job-1", WORKER);
    const live = new Set([WORKER]);
    const sleeps: number[] = [];
    const result = await confirmTeardownRelease(manifestPath, "81", {
      attempts: 3,
      groupCanStillOwnRun: (pgid) => live.has(pgid),
      now: () => "2026-10-06T11:00:01.000Z",
      pidCanStillOwnRun: (pid) => live.has(pid),
      retryMs: 300,
      runtimeAbsent: () => Promise.resolve(true),
      sleep: (ms) => {
        sleeps.push(ms);
        // The signalled worker exits while the teardown waits.
        live.delete(WORKER);
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

// --- PID-reuse reference of recorded pid files --------------------------------

test("a recorded pid file is judged against the later of its mtime and the run's last update", async () => {
  const cases: [string, string, string, boolean][] = [
    // [name, file mtime, live pid start, released]
    [
      "file written after the last update",
      "2026-10-05T22:00:00.000Z",
      "2026-10-05T21:30:00.000Z",
      false,
    ],
    [
      "file written before the last update",
      "2026-10-05T20:30:00.000Z",
      "2026-10-05T20:45:00.000Z",
      false,
    ],
    [
      "pid started after both",
      "2026-10-05T22:00:00.000Z",
      "2026-10-05T22:30:00.000Z",
      true,
    ],
  ];
  for (const [name, mtime, started, released] of cases) {
    await withFixture(async (fixture) => {
      const { manifestPath, runDir } = writeRun(fixture);
      const path = join(runDir, "bridge-worker.json");
      writeFileSync(path, `${JSON.stringify({ pid: 81_003 })}\n`);
      utimesSync(path, new Date(mtime), new Date(mtime));
      const world = newWorld(81_003);
      world.startedAt.set(81_003, at(started));
      if (released) {
        await expectReleased(fixture, world, manifestPath, name);
      } else {
        await expectBlocked(
          fixture,
          world,
          manifestPath,
          "recorded-process-may-be-live: bridge-worker.json pid 81003",
          name
        );
      }
    });
  }
});

// --- Teardown cleanup ---------------------------------------------------------

const workerCommand = (runDir: string, epoch: number, jobId: string) =>
  `/Users/me/.local/bin/loop ${UTILITY_WORKER_SUBCOMMAND} ${runDir} ${epoch} ${jobId}`;

test("teardown ends the run's live utility workers by process group, and only those", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-cleanup-"));
  const otherRun = `${runDir}-other`;
  const original = { ...runProcessCleanupInternals.deps };
  try {
    writeClaimedJob(runDir, "job-a", 5101, "claimed");
    writeClaimedJob(runDir, "job-b", 5102, "running");
    writeClaimedJob(runDir, "job-c", 5103, "running");
    writeClaimedJob(runDir, "job-d", 5104, "running");
    writeClaimedJob(runDir, "job-e", 5105, "failed");
    writeClaimedJob(runDir, "job-f", 5106, "running");
    writeClaimedJob(runDir, "job-g", 5107, "running");
    writeClaimedJob(runDir, "job-h", 5108, "running");
    writeClaimedJob(runDir, "job-i", 5109, "running");
    const commands: Record<number, string> = {
      5101: workerCommand(runDir, 1, "job-a"),
      // Another run's worker.
      5102: workerCommand(otherRun, 1, "job-b"),
      // This run's worker for another job.
      5103: workerCommand(runDir, 1, "job-x"),
      5105: workerCommand(runDir, 1, "job-e"),
      5106: workerCommand(runDir, 1, "job-f"),
      // This job under another epoch's claim.
      5107: workerCommand(runDir, 2, "job-g"),
      // A reused pid: some other program that happens to name the run.
      5108: `/usr/bin/vim ${runDir} 1 job-h`,
      // 5109: alive but `ps` names no command.
    };
    const asked: number[] = [];
    const signals: string[] = [];
    runProcessCleanupInternals.deps.pidAlive = (pid) => pid !== 5104;
    // 5104's group went with it.
    runProcessCleanupInternals.deps.processGroupAlive = () => false;
    runProcessCleanupInternals.deps.commandForPid = (pid) => {
      asked.push(pid);
      return commands[pid];
    };
    runProcessCleanupInternals.deps.signal = (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      if (pid === -5106) {
        // Not a process-group leader: the worker alone is signalled.
        throw Object.assign(new Error("no such process group"), {
          code: "ESRCH",
        });
      }
    };
    const result = cleanupRunOwnedProcesses(runDir, undefined);
    expect(signals).toEqual([
      "-5101:SIGTERM",
      "-5105:SIGTERM",
      "-5106:SIGTERM",
      "5106:SIGTERM",
    ]);
    expect(result.killed).toEqual([5101, 5105, 5106]);
    expect(result.skipped).toEqual([
      { pid: 5102, reason: "utility-worker-command-mismatch" },
      { pid: 5103, reason: "utility-worker-command-mismatch" },
      { pid: 5107, reason: "utility-worker-command-mismatch" },
      { pid: 5108, reason: "utility-worker-command-mismatch" },
      { pid: 5109, reason: "utility-worker-not-running" },
    ]);
    // A dead worker is never looked up, so no unrelated process is inspected.
    expect(asked).not.toContain(5104);
    // The claims stay: a dead pid is the absence evidence the release reads.
    expect(readUtilityJob(runDir, "job-a")?.claim?.workerPid).toBe(5101);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown ends a fenced earlier worker of a re-claimed job, not only the latest claim", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-cleanup-"));
  const original = { ...runProcessCleanupInternals.deps };
  try {
    writeClaimedJob(runDir, "job-r", 5301, "claimed");
    // A second claim of the same job, by another worker under a later epoch,
    // as a re-route after a fence would record it.
    const first = readUtilityJob(runDir, "job-r")?.events.find(
      (event) => event.claim
    );
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}${JSON.stringify({
        ...first,
        at: "2026-10-05T20:40:00.000Z",
        claim: { epoch: 2, workerId: "utility-5302", workerPid: 5302 },
        eventId: "claim:job-r:2:utility-5302",
      })}\n`
    );
    expect(readUtilityJob(runDir, "job-r")?.claim?.workerPid).toBe(5302);
    const signals: number[] = [];
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 5301
        ? workerCommand(runDir, 1, "job-r")
        : workerCommand(runDir, 2, "job-r");
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };
    const result = cleanupRunOwnedProcesses(runDir, undefined);
    expect(signals).toEqual([-5301, -5302]);
    expect(result.killed).toEqual([5301, 5302]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown still ends the workers of a journal whose final append is torn", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-cleanup-"));
  const original = { ...runProcessCleanupInternals.deps };
  try {
    writeClaimedJob(runDir, "job-t", 5401, "running");
    writeFileSync(
      JOURNAL(runDir),
      `${readFileSync(JOURNAL(runDir), "utf8")}{"truncated`
    );
    const signals: number[] = [];
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.commandForPid = () =>
      workerCommand(runDir, 1, "job-t");
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };
    const result = cleanupRunOwnedProcesses(runDir, undefined);
    expect(signals).toEqual([-5401]);
    expect(result.skipped).toEqual([]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown still ends the bridge processes when the utility journal is unreadable", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-cleanup-"));
  const original = { ...runProcessCleanupInternals.deps };
  try {
    mkdirSync(join(runDir, "utility"), { recursive: true });
    writeFileSync(join(runDir, "utility", "jobs.jsonl"), "{not json\n");
    registerRunBridgeProcess(runDir, "claude", 5201);
    const signals: number[] = [];
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 5201 ? `loop __bridge-mcp ${runDir} claude` : undefined;
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };
    const result = cleanupRunOwnedProcesses(runDir, undefined);
    expect(signals).toEqual([5201]);
    expect(result.skipped).toEqual([
      {
        pid: 0,
        reason: expect.stringContaining("utility-jobs-unreadable"),
      },
    ]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("startup GC signals no detached bridge or utility worker of a run it judges abandoned", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-utility-gc-"));
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "88");
  try {
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(
      join(runDir, "manifest.json"),
      createRunManifest({
        cwd: "/repo",
        mode: "paired",
        pid: 8800,
        repoId,
        runId: "88",
        state: "submitted",
        tmuxSession: "abandoned-loop",
      })
    );
    registerRunBridgeProcess(runDir, "claude", 8802);
    writeFileSync(
      join(runDir, "bridge-worker.json"),
      `${JSON.stringify({ pid: 8803 })}\n`
    );
    writeClaimedJob(runDir, "job-g", 8804, "running");
    const asked: number[] = [];
    const signals: number[] = [];
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          asked.push(pid);
          if (pid === 8802) {
            return `loop __bridge-mcp ${runDir} claude`;
          }
          if (pid === 8803) {
            return `loop __bridge-worker ${runDir}`;
          }
          return pid === 8804 ? workerCommand(runDir, 1, "job-g") : undefined;
        },
        // Only the CURRENT server's sessions: the run's own server, if it
        // used another socket, was never asked.
        listTmuxSessions: () => new Set(),
        listeningPids: () => [],
        runtimeAbsent: () => true,
        pidAlive: (pid) => pid !== 8800,
        signal: (pid) => {
          signals.push(pid);
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result.cleaned).toBe(1);
    expect(signals).toEqual([8802]);
    expect(asked).not.toContain(8803);
    expect(asked).not.toContain(8804);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/** A run GC sees as abandoned on the current server: session absent, pid dead. */
const writeGcRun = (
  storageRoot: string,
  repoId: string,
  fields: Record<string, unknown>
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

test("startup GC marks no run failed or released whose own tmux server cannot be shown to lack its session", () => {
  // The current server's list is empty and the run's pid is dead, which is
  // all GC used to need. The run's recorded socket is a present endpoint that
  // will not answer (a plain file stands in for a server GC cannot read): the
  // run may be alive there, so GC must leave it, and its helpers, alone.
  // The production probe is used; it contacts only this scratch path.
  const root = mkdtempSync("/tmp/lgc-");
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  try {
    const socket = join(root, "s");
    writeFileSync(socket, "");
    const runDir = writeGcRun(storageRoot, repoId, { tmuxSocket: socket });
    const before = readFileSync(join(runDir, "manifest.json"));
    const signals: number[] = [];
    const result = gcAbandonedRunProcesses({
      deps: {
        listTmuxSessions: () => new Set(),
        pidAlive: () => false,
        signal: (pid) => {
          signals.push(pid);
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result.cleaned).toBe(0);
    expect(readFileSync(join(runDir, "manifest.json")).equals(before)).toBe(
      true
    );
    expect(signals).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
  // Control: the recorded socket is positively gone, so the run is repaired
  // and released as before.
  const gone = mkdtempSync("/tmp/lgc-");
  try {
    const goneRoot = join(gone, "runs");
    const runDir = writeGcRun(goneRoot, repoId, {
      tmuxSocket: join(gone, "never-created"),
    });
    const result = gcAbandonedRunProcesses({
      deps: { listTmuxSessions: () => new Set(), pidAlive: () => false },
      log: () => undefined,
      repoId,
      storageRoot: goneRoot,
    });
    expect(result.cleaned).toBe(1);
    const after = readRunManifest(join(runDir, "manifest.json"));
    expect(after?.state).toBe("failed");
    expect(after?.workspaceReleasedAt).toBeDefined();
  } finally {
    rmSync(gone, { force: true, recursive: true });
  }
});

test("GC's runtime evidence for a socket-less run is every legacy candidate socket", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-gc-legacy-"));
  try {
    const manifestPath = join(writeGcRun(root, "repo", {}), "manifest.json");
    let probes = 0;
    const absentEverywhere = tmuxRuntimeAbsentForManifestSync(manifestPath, {
      endpointState: () => "absent",
      env: {},
      platform: "darwin",
      tmuxLiveness: () => {
        probes += 1;
        return "unknown";
      },
      uid: 501,
    });
    expect(absentEverywhere).toBe(true);
    // /tmp and /private/tmp, each for tmux's default and the per-repo dir.
    expect(probes).toBe(4);
    let calls = 0;
    const liveOnOne = tmuxRuntimeAbsentForManifestSync(manifestPath, {
      endpointState: () => "present",
      env: {},
      platform: "darwin",
      tmuxLiveness: () => {
        calls += 1;
        return calls === 3 ? "live" : "dead";
      },
      uid: 501,
    });
    expect(liveOnOne).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- A worker that claims after its run stopped does no work ------------------

const writeRoutedJob = (runDir: string, repoRoot: string, jobId: string) => {
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    createdAt: CREATED_AT,
    id: jobId,
    kind: "inspect",
    objective: "Inspect the worker configuration",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 1);
  transitionUtilityJob(runDir, jobId, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
      // A workspace that cannot be verified: a worker that does start fails
      // the job at once, before any model or tool is reached.
      workspace: {
        readScope: ["src"],
        root: join(repoRoot, "missing-workspace"),
        writeScope: [],
      },
    },
    routeEpoch: 1,
  });
};

test("a utility worker that claims a job after its run turned terminal cancels it without starting", async () => {
  const shapes: [string, Record<string, unknown>, boolean][] = [
    ["stopped", { state: "stopped", status: "stopped" }, false],
    ["failed", { state: "failed", status: "failed" }, false],
    [
      "stopped and handed back",
      { state: "stopped", status: "stopped", workspaceReleasedAt: NOW },
      false,
    ],
    // A handback marker alone never cancels: an active run with a stale
    // marker (an older binary's resume left it behind) is still active.
    [
      "active with a stale handback",
      { state: "working", status: "running", workspaceReleasedAt: NOW },
      true,
    ],
    // Control: an active run's worker does start.
    ["active", { state: "working", status: "running" }, true],
  ];
  for (const [name, fields, starts] of shapes) {
    const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-claim-"));
    const runDir = join(repoRoot, ".loop", "runs", "81");
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "manifest.json"),
        `${JSON.stringify({
          ...createRunManifest({
            cwd: repoRoot,
            mode: "paired",
            pid: 81_001,
            repoId: "repo",
            runId: "81",
          }),
          ...fields,
        })}\n`
      );
      writeRoutedJob(runDir, repoRoot, "job-late");
      await runUtilityWorker(runDir, 1, "job-late", {});
      const job = readUtilityJob(runDir, "job-late");
      const states = job?.events.map((event) => event.state);
      expect(job?.claim?.workerPid, name).toBe(process.pid);
      if (starts) {
        expect(states, name).toContain("running");
        continue;
      }
      expect(states, name).not.toContain("running");
      expect(job?.state, name).toBe("canceled");
      expect(job?.events.at(-1)?.reason, name).toContain(
        `run is no longer active: it is ${fields.state}`
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }
});

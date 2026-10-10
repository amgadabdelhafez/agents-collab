// A clean teardown now records a workspace handback (`workspaceReleasedAt`).
// A run can be resumed after that (`loop --tmux --run-id N`). These tests pin
// that the resume clears the handback (under the launch lock, and in the
// manifest the resumed run writes), that a resumed run's helpers start, and
// that stopping the resumed run again is judged on fresh evidence rather than
// reported as the earlier release.
//
// tmux liveness, the socket endpoint probe and process liveness are fakes:
// no tmux server is started or contacted, and no process is signalled.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { confirmTeardownRelease } from "../../src/loop/governess";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import { preparePairedRun } from "../../src/loop/paired-options";
import {
  createRunManifest,
  readRunManifest,
  reconcileLegacyStoppedRun,
  resolveRepoId,
  resolveStorageRoot,
  setRunManifestState,
  touchRunManifest,
  updateRunManifest,
} from "../../src/loop/run-state";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import type { TmuxEndpointState, TmuxTarget } from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";
import { runUtilityWorker } from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const SOCKET = "/tmp/ls-resume-after-release/run.sock";
const CREATED_AT = "2026-10-05T20:00:00.000Z";
const STOPPED_AT = "2026-10-05T21:00:00.000Z";
const RELEASED_AT = "2026-10-05T21:00:01.000Z";
const NOW = "2026-10-06T12:00:00.000Z";

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

const fakeDeps = (home: string, tmux: "dead" | "live") => ({
  // A live session answers through a present socket; a dead run's socket
  // file is gone.
  endpointState: (target: TmuxTarget | undefined): TmuxEndpointState => {
    if (!target) {
      return "unknown";
    }
    return tmux === "live" ? "present" : "absent";
  },
  env: {} as Record<string, string | undefined>,
  home,
  isPidAlive: () => false,
  log: () => undefined,
  makeClaimId: () => "resume-attempt",
  now: () => NOW,
  pid: 4242,
  pidStartedAt: () => undefined,
  platform: "darwin",
  tmuxLiveness: () => tmux,
  uid: 501,
});

interface Fixture {
  binding: LaunchWorkspaceBinding;
  home: string;
  manifestPath: string;
  root: string;
}

let fixture: Fixture;
let savedHome: string | undefined;
let savedRunId: string | undefined;

/** Run 81 was torn down cleanly: stopped, its handback recorded. */
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "loop-resume-release-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-resume-release-home-"));
  savedHome = process.env.HOME;
  savedRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  const binding: LaunchWorkspaceBinding = {
    branchRef: "refs/heads/main",
    repoId: resolveRepoId(root),
    root,
  };
  const runDir = join(resolveStorageRoot(home), binding.repoId, "81");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...createRunManifest(
          {
            cwd: root,
            mode: "paired",
            pid: 81_001,
            repoId: binding.repoId,
            runId: "81",
            state: "stopped",
            workspaceBinding: binding,
          },
          CREATED_AT
        ),
        state: "stopped",
        status: "stopped",
        tmuxSession: "resume-loop-81",
        tmuxSocket: SOCKET,
        updatedAt: RELEASED_AT,
        workspaceReleasedAt: RELEASED_AT,
      },
      null,
      2
    )}\n`
  );
  fixture = { binding, home, manifestPath, root };
});

afterEach(() => {
  if (savedHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = savedHome;
  }
  if (savedRunId === undefined) {
    Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  } else {
    process.env.LOOP_RUN_ID = savedRunId;
  }
  rmSync(fixture.root, { force: true, recursive: true });
  rmSync(fixture.home, { force: true, recursive: true });
});

test("a resume reservation clears the earlier handback under the launch lock", async () => {
  const claim = await reservePairedLaunch(
    makeOptions({ resumeRunId: "81" }),
    fixture.binding,
    fakeDeps(fixture.home, "dead")
  );
  expect(claim.storage.runId).toBe("81");
  const after = readRunManifest(fixture.manifestPath);
  expect(after?.launchAttemptPid).toBe(4242);
  expect(after?.workspaceReleasedAt).toBeUndefined();
});

test("a resume that re-attaches to a live session clears the handback too", async () => {
  updateRunManifest(fixture.manifestPath, (current) =>
    current
      ? { ...current, workspaceReleaseKind: "abandoned-never-bound" }
      : undefined
  );
  const claim = await reservePairedLaunch(
    makeOptions({ resumeRunId: "81" }),
    fixture.binding,
    fakeDeps(fixture.home, "live")
  );
  expect(claim.reserved).toBe(false);
  const after = readRunManifest(fixture.manifestPath);
  expect(after?.workspaceReleasedAt).toBeUndefined();
  expect(after?.workspaceReleaseKind).toBeUndefined();
  expect(after?.state).toBe("stopped");
});

test("the resumed run's manifest is active and carries no handback", () => {
  const prepared = preparePairedRun(
    makeOptions({ resumeRunId: "81" }),
    fixture.root
  );
  expect(prepared.storage.manifestPath).toBe(fixture.manifestPath);
  expect(prepared.manifest.state).toBe("submitted");
  expect(prepared.manifest.workspaceReleasedAt).toBeUndefined();
  const persisted = readRunManifest(fixture.manifestPath);
  expect(persisted?.state).toBe("submitted");
  expect(persisted?.workspaceReleasedAt).toBeUndefined();
});

test("an active manifest never keeps a handback through the state writers", () => {
  const released = {
    ...createRunManifest({
      cwd: fixture.root,
      mode: "paired",
      pid: 1,
      repoId: "repo",
      runId: "81",
      state: "stopped",
    }),
    workspaceReleaseKind: "abandoned-never-bound" as const,
    workspaceReleasedAt: RELEASED_AT,
  };
  const working = setRunManifestState(released, "working", NOW);
  expect(working.workspaceReleasedAt).toBeUndefined();
  expect(working.workspaceReleaseKind).toBeUndefined();
  const touched = touchRunManifest({ ...released, state: "submitted" }, NOW);
  expect(touched.workspaceReleasedAt).toBeUndefined();
  // A terminal state keeps its handback.
  expect(touchRunManifest(released, NOW).workspaceReleasedAt).toBe(RELEASED_AT);
  expect(setRunManifestState(released, "failed", NOW).workspaceReleasedAt).toBe(
    RELEASED_AT
  );
});

test("a resumed run's utility worker starts its job", async () => {
  preparePairedRun(makeOptions({ resumeRunId: "81" }), fixture.root);
  updateRunManifest(fixture.manifestPath, (current) =>
    current ? setRunManifestState(current, "working") : undefined
  );
  const runDir = dirname(fixture.manifestPath);
  appendUtilityRouteRequest(
    runDir,
    createUtilityRouteRequest({
      acceptanceCriteria: ["return source-backed evidence"],
      authority: {},
      createdAt: CREATED_AT,
      id: "job-resumed",
      kind: "inspect",
      objective: "Inspect the worker configuration",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    })
  );
  activateUtilityEpoch(runDir, 1);
  transitionUtilityJob(runDir, "job-resumed", "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
      // An unverifiable workspace: the started job fails at once, before
      // any model or tool is reached.
      workspace: {
        readScope: ["src"],
        root: join(fixture.root, "missing-workspace"),
        writeScope: [],
      },
    },
    routeEpoch: 1,
  });
  await runUtilityWorker(runDir, 1, "job-resumed", {});
  const job = readUtilityJob(runDir, "job-resumed");
  expect(job?.events.map((event) => event.state)).toContain("running");
  expect(job?.state).not.toBe("canceled");
});

test("stopping the resumed run again is judged afresh, never reported as the earlier release", async () => {
  preparePairedRun(makeOptions({ resumeRunId: "81" }), fixture.root);
  // The resumed run's governess tears it down: its manifest goes to stopped.
  updateRunManifest(fixture.manifestPath, (current) =>
    current ? setRunManifestState(current, "stopped") : undefined
  );
  const live = new Set([process.pid]);
  const result = await confirmTeardownRelease(fixture.manifestPath, "81", {
    attempts: 1,
    now: () => NOW,
    pidCanStillOwnRun: (pid) => live.has(pid),
    retryMs: 0,
    runtimeAbsent: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
  });
  expect(result).toEqual({
    detail: "run-process-may-be-live",
    released: false,
  });
  expect(readRunManifest(fixture.manifestPath)?.workspaceReleasedAt).toBe(
    undefined
  );
});

test("a recorded handback is no release of a run that is no longer in its terminal state", async () => {
  // As an older binary's resume would have left it: active, marker kept.
  writeFileSync(
    fixture.manifestPath,
    `${JSON.stringify({
      ...readRunManifest(fixture.manifestPath),
      state: "working",
      status: "running",
      workspaceReleasedAt: RELEASED_AT,
    })}\n`
  );
  const result = await reconcileLegacyStoppedRun(fixture.manifestPath, "81", {
    now: () => NOW,
    pidCanStillOwnRun: () => false,
    runtimeAbsent: () => Promise.resolve(true),
    terminalState: "stopped",
  });
  expect(result).toEqual({
    reason: "run-is-not-stopped",
    runId: "81",
    status: "refused",
  });
  // Control: still stopped, the recorded handback stands.
  updateRunManifest(fixture.manifestPath, (current) =>
    current
      ? {
          ...current,
          state: "stopped",
          status: "stopped",
          updatedAt: STOPPED_AT,
          workspaceReleasedAt: RELEASED_AT,
        }
      : undefined
  );
  expect(
    await reconcileLegacyStoppedRun(fixture.manifestPath, "81", {
      now: () => NOW,
      pidCanStillOwnRun: () => false,
      runtimeAbsent: () => Promise.resolve(true),
      terminalState: "stopped",
    })
  ).toEqual({
    runId: "81",
    status: "already-released",
    workspaceReleasedAt: RELEASED_AT,
  });
});

// A finished run closes its governess-beat workflow. Each named check fails if
// the thing it names is absent:
//
//   close        — a terminal run's RUNNING workflow is terminated on a real
//                  Temporal test server, and its journal is still readable.
//   live         — a run in any active state is never closed, and not even
//                  described.
//   ownership    — a workflow whose owner memo names another repo, or that
//                  runs on another task queue, is refused; one with no memo
//                  is refused, whoever asks (fix7: under the legacy id it may
//                  be another repo's).
//   collision    — fix7: two repos with the same run id sharing a namespace
//                  each close only their own workflow; an in-flight legacy
//                  `governess-beat:<runId>` is closed by its owner and never
//                  by the other repo.
//   reconcile    — startup closes completed, stopped and failed (abandoned)
//                  runs, skips live and tmux-alive runs, and a second pass
//                  closes nothing.
//   no-op        — with the Temporal settings unset nothing is dialled.
//   governess    — teardown closes after marking the run stopped and before
//                  killing its session, and the real default close detaches
//                  the journal sink first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  defaultGovernessDeps,
  type GovernessConfig,
  stopGovernessLoop,
} from "../../src/loop/governess";
import {
  closeGovernessBeatForTerminalRun,
  closeGovernessBeatWorkflow,
  connectGovernessBeatWorkflowControl,
  createGovernessBeatWorkflowControl,
  type GovernessBeatWorkflowControl,
  reconcileGovernessBeatWorkflows,
} from "../../src/loop/governess-beat-close";
import {
  governessBeatLegacyWorkflowId,
  governessBeatOwnedWorkflowId,
  governessBeatOwner,
  governessBeatOwnerMemo,
} from "../../src/loop/governess-beat-identity";
import { listGovernessBeatExecutions } from "../../src/loop/governess-beat-list";
import { GOVERNESS_BEAT_WORKFLOW_TYPE } from "../../src/loop/governess-beat-workflow";
import {
  prepareGovernessControl,
  readGovernessJournal,
} from "../../src/loop/governess-journal";
import type { GovernessControlRecord } from "../../src/loop/governess-journal-core";
import {
  attachGovernessJournalBackend,
  createGovernessTemporalJournalClient,
  type GovernessTemporalJournalClient,
  governessHostTaskQueue,
} from "../../src/loop/governess-temporal-journal";
import {
  createRunManifest,
  type RunManifest,
  readRunManifest,
  setRunManifestState,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { RunLifecycleState } from "../../src/loop/types";

// The error text a call failed with, or "resolved". Awaited directly, not
// through expect().rejects, which stalled the gRPC client under bun.
const refusal = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const REPO = "repo-beat-close";
const OTHER_REPO = "repo-someone-else";
const TASK_QUEUE = `beat-close-${process.pid}`;
// The queue governessTemporalConfigFromEnv defaults to, which TEMPORAL_ENV uses.
const DEFAULT_QUEUE = "loop-governess";
const ACTIVE_STATES: RunLifecycleState[] = [
  "submitted",
  "working",
  "reviewing",
  "input-required",
];
const TEMPORAL_ENV = {
  LOOP_GOVERNESS_TEMPORAL_ADDRESS: "127.0.0.1:7233",
  LOOP_GOVERNESS_TEMPORAL_NAMESPACE: "harness",
};

const ownedId = (
  runId: string,
  repoId = REPO,
  taskQueue = TASK_QUEUE
): string =>
  governessBeatOwnedWorkflowId(
    governessBeatOwner({ repoId, runId, taskQueue })
  );

const ownerMemo = (
  runId: string,
  repoId = REPO,
  taskQueue = TASK_QUEUE
): Record<string, string> =>
  governessBeatOwnerMemo(governessBeatOwner({ repoId, runId, taskQueue }));

const manifestFor = (
  runId: string,
  state: RunLifecycleState,
  extra: Partial<Parameters<typeof createRunManifest>[0]> = {}
): RunManifest =>
  createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1,
    repoId: REPO,
    runId,
    state,
    ...extra,
  });

const record = (at: string): GovernessControlRecord => {
  const journal = join(mkdtempSync(join(tmpdir(), "beat-close-rec-")), "j");
  return prepareGovernessControl(journal, {
    action: "teardown-loop",
    at,
    epoch: 1,
    idempotencyKey: `key-${at}`,
    payload: "session:reason",
    policyClass: "require-confirmation",
    policyContext: { confirmed: true, fenceCurrent: true },
  });
};

interface FakeExecution {
  memo?: Record<string, unknown>;
  status: string;
  taskQueue?: string;
}

/** A control that records calls and serves a scripted server state. */
const fakeControl = (
  workflows: Record<string, FakeExecution>
): GovernessBeatWorkflowControl & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    close: () => {
      calls.push("close");
      return Promise.resolve();
    },
    describe: (workflowId) => {
      calls.push(`describe:${workflowId}`);
      const found = workflows[workflowId];
      return Promise.resolve(
        found
          ? {
              executionRunId: `run-of-${workflowId}`,
              memo: found.memo,
              status: found.status,
              taskQueue: found.taskQueue ?? DEFAULT_QUEUE,
            }
          : undefined
      );
    },
    terminate: (workflowId, executionRunId) => {
      calls.push(`terminate:${workflowId}@${executionRunId}`);
      const found = workflows[workflowId];
      if (found) {
        found.status = "TERMINATED";
      }
      return Promise.resolve();
    },
  };
};

describe("governess-beat close on a real Temporal test server", () => {
  let environment: TestWorkflowEnvironment;
  let sequence = 0;

  const journalClient = (ownerRepoId = REPO): GovernessTemporalJournalClient =>
    createGovernessTemporalJournalClient({
      client: environment.client.workflow,
      decode: (payload) =>
        defaultPayloadConverter.fromPayload(
          payload as Parameters<typeof defaultPayloadConverter.fromPayload>[0]
        ),
      ownerRepoId,
      settleTimeoutMs: 2000,
      taskQueue: TASK_QUEUE,
    });

  const control = (): GovernessBeatWorkflowControl =>
    createGovernessBeatWorkflowControl({ client: environment.client.workflow });

  // Starts the run's beat the way the live journal does. No worker polls
  // TASK_QUEUE, exactly as in production.
  const startBeat = async (
    runId: string,
    ownerRepoId = REPO
  ): Promise<void> => {
    await journalClient(ownerRepoId).appendRecord(
      runId,
      record("2026-09-18T00:00:00.000Z")
    );
  };

  // An execution created as the pre-fix7 journal (or another owner) would:
  // signalWithStart under any id, with whatever memo and queue it chose.
  const plantBeat = async (input: {
    memo?: Record<string, string>;
    runId: string;
    taskQueue?: string;
    workflowId: string;
  }): Promise<void> => {
    const at = "2026-09-18T00:00:00.000Z";
    await environment.client.workflow.signalWithStart("temporalWorkflow", {
      args: [
        {
          at,
          input: { runId: input.runId },
          requestId: `start:${input.runId}`,
          workflowId: input.workflowId,
          workflowType: GOVERNESS_BEAT_WORKFLOW_TYPE,
        },
      ],
      ...(input.memo ? { memo: input.memo } : {}),
      signal: "workflow-port-command",
      signalArgs: [
        {
          at,
          kind: "signal",
          name: "append_record",
          payload: { record: record(at) },
          requestId: "append:1:planted",
        },
      ],
      taskQueue: input.taskQueue ?? TASK_QUEUE,
      workflowId: input.workflowId,
    });
  };

  const statusOf = async (workflowId: string): Promise<string> =>
    (await environment.client.workflow.getHandle(workflowId).describe()).status
      .name;

  const nextRunId = (): string => {
    sequence += 1;
    return `beat-close-${process.pid}-${sequence}`;
  };

  const closeAs = (
    runId: string,
    repoId = REPO,
    state: RunLifecycleState = "stopped"
  ) =>
    closeGovernessBeatWorkflow({
      control: control(),
      manifest: manifestFor(runId, state, { repoId }),
      reason: "test",
      repoId,
      runId,
      taskQueue: TASK_QUEUE,
    });

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 180_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  test("close: the journal writes the full owner memo when it creates the workflow", async () => {
    const runId = nextRunId();
    await startBeat(runId);
    const described = await environment.client.workflow
      .getHandle(ownedId(runId))
      .describe();
    expect(described.memo).toEqual(ownerMemo(runId));
    expect(described.taskQueue).toBe(TASK_QUEUE);
  });

  for (const state of ["completed", "failed", "stopped"] as const) {
    test(`close: a ${state} run's running beat workflow is terminated and its journal stays readable`, async () => {
      const runId = nextRunId();
      await startBeat(runId);
      expect(await statusOf(ownedId(runId))).toBe("RUNNING");
      const closed = await closeAs(runId, REPO, state);
      expect(closed).toEqual({
        outcome: "terminated",
        workflowId: ownedId(runId),
      });
      expect(await statusOf(ownedId(runId))).toBe("TERMINATED");
      expect(await journalClient().readRecords(runId)).toHaveLength(1);
    });
  }

  for (const state of ACTIVE_STATES) {
    test(`live: a ${state} run's workflow is never closed`, async () => {
      const runId = nextRunId();
      await startBeat(runId);
      const closed = await closeAs(runId, REPO, state);
      expect(closed.outcome).toBe("refused-live");
      expect(await statusOf(ownedId(runId))).toBe("RUNNING");
    });
  }

  test("ownership: an execution under this run's id whose memo names another repo is refused", async () => {
    const runId = nextRunId();
    await plantBeat({
      memo: ownerMemo(runId, OTHER_REPO),
      runId,
      workflowId: ownedId(runId),
    });
    const closed = await closeAs(runId);
    expect(closed).toMatchObject({
      detail: `owned by ${OTHER_REPO}`,
      outcome: "refused-foreign",
    });
    expect(await statusOf(ownedId(runId))).toBe("RUNNING");
  });

  test("ownership: an execution under this run's id on another task queue is refused", async () => {
    const runId = nextRunId();
    await plantBeat({
      memo: ownerMemo(runId),
      runId,
      taskQueue: `${TASK_QUEUE}-elsewhere`,
      workflowId: ownedId(runId),
    });
    const closed = await closeAs(runId);
    expect(closed.outcome).toBe("refused-foreign");
    expect(await statusOf(ownedId(runId))).toBe("RUNNING");
  });

  test("ownership: an unowned execution, owned or legacy id, is refused whoever asks", async () => {
    const runId = nextRunId();
    await plantBeat({ runId, workflowId: ownedId(runId) });
    await plantBeat({
      runId,
      workflowId: governessBeatLegacyWorkflowId(runId),
    });
    const closed = await closeAs(runId);
    expect(closed).toMatchObject({
      legacy: {
        outcome: "refused-unowned",
        workflowId: governessBeatLegacyWorkflowId(runId),
      },
      outcome: "refused-unowned",
    });
    expect(await statusOf(ownedId(runId))).toBe("RUNNING");
    expect(await statusOf(governessBeatLegacyWorkflowId(runId))).toBe(
      "RUNNING"
    );
    // The run's own governess, the old exception, refuses too.
    const runDir = mkdtempSync(join(tmpdir(), "beat-close-unowned-"));
    const manifestPath = join(runDir, "manifest.json");
    writeRunManifest(manifestPath, manifestFor(runId, "stopped"));
    const own = await defaultGovernessDeps().closeBeatWorkflow?.(
      {
        journalTemporal: {
          address: environment.address,
          namespace: environment.namespace ?? "default",
          taskQueue: TASK_QUEUE,
        },
        manifestPath,
        repoId: REPO,
        runId,
      } as unknown as GovernessConfig,
      "teardown"
    );
    expect(own?.outcome).toBe("refused-unowned");
    expect(own?.legacy?.outcome).toBe("refused-unowned");
    expect(await statusOf(governessBeatLegacyWorkflowId(runId))).toBe(
      "RUNNING"
    );
    rmSync(runDir, { force: true, recursive: true });
  });

  test("collision: two repos with the same run id on one namespace and queue each close only their own", async () => {
    const runId = nextRunId();
    await startBeat(runId, REPO);
    await startBeat(runId, OTHER_REPO);
    expect(ownedId(runId, REPO)).not.toBe(ownedId(runId, OTHER_REPO));

    const mine = await closeAs(runId, REPO);
    expect(mine).toEqual({ outcome: "terminated", workflowId: ownedId(runId) });
    expect(await statusOf(ownedId(runId, REPO))).toBe("TERMINATED");
    expect(await statusOf(ownedId(runId, OTHER_REPO))).toBe("RUNNING");
    // The other repo's journal is whole and still its own.
    expect(await journalClient(OTHER_REPO).readRecords(runId)).toHaveLength(1);

    const theirs = await closeAs(runId, OTHER_REPO);
    expect(theirs.outcome).toBe("terminated");
    expect(await statusOf(ownedId(runId, OTHER_REPO))).toBe("TERMINATED");
  });

  test("collision: an in-flight legacy execution is closed by its owner and never by the other repo", async () => {
    const runId = nextRunId();
    const legacyId = governessBeatLegacyWorkflowId(runId);
    // What the pre-fix7 journal left for OTHER_REPO's run: legacy id, memo
    // naming only the repo, this deployment's queue.
    await plantBeat({
      memo: { loopRepoId: OTHER_REPO },
      runId,
      workflowId: legacyId,
    });
    await startBeat(runId, REPO);

    const mine = await closeAs(runId, REPO);
    expect(mine).toEqual({
      legacy: {
        detail: `owned by ${OTHER_REPO}`,
        outcome: "refused-foreign",
        workflowId: legacyId,
      },
      outcome: "terminated",
      workflowId: ownedId(runId, REPO),
    });
    expect(await statusOf(legacyId)).toBe("RUNNING");

    const theirs = await closeAs(runId, OTHER_REPO);
    expect(theirs).toEqual({
      legacy: { outcome: "terminated", workflowId: legacyId },
      outcome: "absent",
      workflowId: ownedId(runId, OTHER_REPO),
    });
    expect(await statusOf(legacyId)).toBe("TERMINATED");
  });

  test("collision: a legacy execution on another deployment's queue is refused even with this repo's memo", async () => {
    const runId = nextRunId();
    const legacyId = governessBeatLegacyWorkflowId(runId);
    await plantBeat({
      memo: { loopRepoId: REPO },
      runId,
      taskQueue: `${TASK_QUEUE}-other-host`,
      workflowId: legacyId,
    });
    const closed = await closeAs(runId);
    expect(closed.legacy?.outcome).toBe("refused-foreign");
    expect(await statusOf(legacyId)).toBe("RUNNING");
  });

  test("close: the terminate addresses the verified run, never a later one under the same id", async () => {
    const runId = nextRunId();
    await startBeat(runId);
    const real = control();
    let swapped = false;
    const racing: GovernessBeatWorkflowControl = {
      close: () => real.close(),
      describe: (workflowId) => real.describe(workflowId),
      async terminate(workflowId, executionRunId, reason) {
        // Between describe and terminate the verified run ends and another
        // owner starts a new run under the same id.
        if (!swapped && workflowId === ownedId(runId)) {
          swapped = true;
          await environment.client.workflow
            .getHandle(workflowId)
            .terminate("replaced");
          await plantBeat({
            memo: ownerMemo(runId, OTHER_REPO),
            runId,
            workflowId,
          });
        }
        await real.terminate(workflowId, executionRunId, reason);
      },
    };
    const closed = await closeGovernessBeatWorkflow({
      control: racing,
      manifest: manifestFor(runId, "stopped"),
      reason: "test",
      repoId: REPO,
      runId,
      taskQueue: TASK_QUEUE,
    });
    expect(closed.outcome).toBe("already-closed");
    expect(await statusOf(ownedId(runId))).toBe("RUNNING");
  });

  test("deadline: the connected control bounds describe and terminate on a real server", async () => {
    const runId = nextRunId();
    await startBeat(runId);
    const config = {
      address: environment.address,
      namespace: environment.namespace ?? "default",
      taskQueue: TASK_QUEUE,
    };
    const workflowId = ownedId(runId);
    const runOf = (
      await environment.client.workflow.getHandle(workflowId).describe()
    ).runId;
    const expired = await connectGovernessBeatWorkflowControl(config, 0);
    try {
      // A deadline that has already passed fails the call instead of waiting.
      expect(await refusal(expired.describe(workflowId))).not.toBe("resolved");
      expect(
        await refusal(expired.terminate(workflowId, runOf, "test"))
      ).not.toBe("resolved");
    } finally {
      await expired.close();
    }
    expect(await statusOf(workflowId)).toBe("RUNNING");
    const bounded = await connectGovernessBeatWorkflowControl(config);
    try {
      expect((await bounded.describe(workflowId))?.status).toBe("RUNNING");
    } finally {
      await bounded.close();
    }
  });

  test("close: absent and already-closed workflows are no-ops", async () => {
    const absentRun = nextRunId();
    expect(await closeAs(absentRun)).toEqual({
      outcome: "absent",
      workflowId: ownedId(absentRun),
    });
    const runId = nextRunId();
    await startBeat(runId);
    expect((await closeAs(runId)).outcome).toBe("terminated");
    const again = await closeAs(runId);
    expect(again).toMatchObject({
      detail: "TERMINATED",
      outcome: "already-closed",
    });
  });

  test("reconcile: closes completed, stopped and abandoned-failed runs, skips live ones, and is idempotent", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "beat-close-runs-"));
    const runs = {
      abandoned: nextRunId(),
      completed: nextRunId(),
      liveTmux: nextRunId(),
      stopped: nextRunId(),
      working: nextRunId(),
    };
    const write = (manifest: RunManifest): void => {
      const runDir = join(storageRoot, REPO, manifest.runId);
      mkdirSync(runDir, { recursive: true });
      writeRunManifest(join(runDir, "manifest.json"), manifest);
    };
    write(manifestFor(runs.completed, "completed"));
    write(
      manifestFor(runs.stopped, "stopped", { tmuxSession: "gone-session" })
    );
    // Abandoned-run GC marks a run failed the same startup, just before this.
    write(manifestFor(runs.abandoned, "failed"));
    write(manifestFor(runs.working, "working"));
    // A stopped run whose tmux session is still up: its governess may still
    // be flushing, so reconcile leaves it to the governess.
    write(
      manifestFor(runs.liveTmux, "stopped", { tmuxSession: "live-session" })
    );
    for (const runId of Object.values(runs)) {
      await startBeat(runId);
    }
    // The stopped run also left an owned legacy execution from an old build.
    await plantBeat({
      memo: { loopRepoId: REPO },
      runId: runs.stopped,
      workflowId: governessBeatLegacyWorkflowId(runs.stopped),
    });
    const reconcile = () =>
      reconcileGovernessBeatWorkflows({
        connect: async () => control(),
        env: {
          ...TEMPORAL_ENV,
          LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE: TASK_QUEUE,
        },
        listTmuxSessions: () => new Set(["live-session"]),
        log: () => undefined,
        repoId: REPO,
        storageRoot,
      });

    const first = await reconcile();
    expect(first).toEqual({
      checked: 3,
      failed: 0,
      outcomes: { terminated: 4 },
      skippedLive: 1,
    });
    expect(await statusOf(ownedId(runs.completed))).toBe("TERMINATED");
    expect(await statusOf(ownedId(runs.stopped))).toBe("TERMINATED");
    expect(await statusOf(governessBeatLegacyWorkflowId(runs.stopped))).toBe(
      "TERMINATED"
    );
    expect(await statusOf(ownedId(runs.abandoned))).toBe("TERMINATED");
    expect(await statusOf(ownedId(runs.working))).toBe("RUNNING");
    expect(await statusOf(ownedId(runs.liveTmux))).toBe("RUNNING");

    const second = await reconcile();
    expect(second).toEqual({
      checked: 3,
      failed: 0,
      outcomes: { "already-closed": 4 },
      skippedLive: 1,
    });
    expect(await statusOf(ownedId(runs.working))).toBe("RUNNING");
    rmSync(storageRoot, { force: true, recursive: true });
  });

  test("inventory: the read-only listing classifies every beat execution on a queue, and the script prints it", async () => {
    const runId = nextRunId();
    const closedRun = nextRunId();
    const legacyOwned = governessBeatLegacyWorkflowId(`${runId}-o`);
    const legacyUnowned = governessBeatLegacyWorkflowId(`${runId}-u`);
    await startBeat(runId);
    await startBeat(closedRun);
    await closeAs(closedRun);
    await plantBeat({
      memo: { loopRepoId: OTHER_REPO },
      runId: `${runId}-o`,
      workflowId: legacyOwned,
    });
    await plantBeat({ runId: `${runId}-u`, workflowId: legacyUnowned });
    // Same workflow function and queue, not a beat: never listed.
    await plantBeat({ runId, workflowId: `supervisor-message:${runId}` });
    const histories = async () =>
      Promise.all(
        [ownedId(runId), legacyOwned, legacyUnowned].map(
          async (id) =>
            (await environment.client.workflow.getHandle(id).fetchHistory())
              .events?.length
        )
      );
    const before = await histories();

    const wanted = [ownedId(runId), legacyOwned, legacyUnowned];
    let listed: Awaited<ReturnType<typeof listGovernessBeatExecutions>> = [];
    // Visibility is eventually consistent.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      listed = await listGovernessBeatExecutions(environment.client.workflow, {
        taskQueue: TASK_QUEUE,
      });
      if (wanted.every((id) => listed.some((one) => one.workflowId === id))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const kindOf = (id: string) =>
      listed.find((one) => one.workflowId === id)?.kind;
    expect(kindOf(ownedId(runId))).toBe("v2");
    expect(kindOf(legacyOwned)).toBe("legacy-owned");
    expect(listed.find((one) => one.workflowId === legacyOwned)).toMatchObject({
      ownerRepoId: OTHER_REPO,
      runId: `${runId}-o`,
      status: "RUNNING",
    });
    expect(kindOf(legacyUnowned)).toBe("legacy-unowned");
    expect(kindOf(ownedId(closedRun))).toBeUndefined();
    expect(kindOf(`supervisor-message:${runId}`)).toBeUndefined();
    const withClosed = await listGovernessBeatExecutions(
      environment.client.workflow,
      { includeClosed: true, taskQueue: TASK_QUEUE }
    );
    expect(
      withClosed.find((one) => one.workflowId === ownedId(closedRun))?.status
    ).toBe("TERMINATED");

    const script = spawnSync(
      process.execPath,
      [
        "run",
        "scripts/governess-beat-list.ts",
        "--address",
        environment.address,
        "--namespace",
        environment.namespace ?? "default",
        "--task-queue",
        TASK_QUEUE,
      ],
      { cwd: join(import.meta.dir, "../..") }
    );
    expect(script.status).toBe(0);
    const printed = script.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; workflowId: string });
    for (const id of wanted) {
      expect(
        printed.some((one) => one.workflowId === id),
        id
      ).toBe(true);
    }
    expect(script.stderr.toString()).toContain("governess-beat executions:");
    // Listing is read-only: no history grew.
    expect(await histories()).toEqual(before);
  });

  test("governess: the default close detaches the journal sink, then terminates the stopped run's workflow", async () => {
    const runId = nextRunId();
    const runDir = mkdtempSync(join(tmpdir(), "beat-close-gov-"));
    const manifestPath = join(runDir, "manifest.json");
    writeRunManifest(manifestPath, manifestFor(runId, "working"));
    const journalFile = join(runDir, "governess-control.jsonl");
    const temporal = {
      address: environment.address,
      namespace: environment.namespace ?? "default",
      taskQueue: TASK_QUEUE,
    };
    const backend = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO),
      journalFile,
      ownerRepoId: REPO,
      runId,
      temporal,
    });
    prepareGovernessControl(journalFile, {
      action: "teardown-loop",
      at: "2026-09-18T00:00:00.000Z",
      epoch: 1,
      idempotencyKey: "gov-close",
      payload: "session:reason",
      policyClass: "require-confirmation",
      policyContext: { confirmed: true, fenceCurrent: true },
    });
    const config = {
      journalBackend: backend,
      journalFile,
      journalTemporal: temporal,
      manifestPath,
      repoId: REPO,
      runId,
    } as unknown as GovernessConfig;
    const close = defaultGovernessDeps().closeBeatWorkflow;
    expect(close).toBeDefined();

    // Live: the run is still working, so the governess refuses.
    expect((await close?.(config, "early"))?.outcome).toBe("refused-live");
    expect(await statusOf(ownedId(runId))).toBe("RUNNING");

    writeRunManifest(
      manifestPath,
      setRunManifestState(
        readRunManifest(manifestPath) as RunManifest,
        "stopped"
      )
    );
    const closed = await close?.(config, "user requested teardown");
    expect(closed?.outcome).toBe("terminated");
    expect(await statusOf(ownedId(runId))).toBe("TERMINATED");
    expect(config.journalBackend).toBeUndefined();
    // Records after the close stay in the file and never reopen the workflow.
    prepareGovernessControl(journalFile, {
      action: "teardown-loop",
      at: "2026-09-18T00:00:01.000Z",
      epoch: 1,
      idempotencyKey: "after-close",
      payload: "session:later",
      policyClass: "require-confirmation",
      policyContext: { confirmed: true, fenceCurrent: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readGovernessJournal(journalFile)).toHaveLength(2);
    expect(await statusOf(ownedId(runId))).toBe("TERMINATED");
    rmSync(runDir, { force: true, recursive: true });
  });

  // The dead-run release on the Temporal-journal line: the real default beat
  // close runs before the agent groups are collected and the session killed,
  // and the workspace handback is attempted only after the kill and the end
  // of the collected groups, with the workflow already closed.
  test("governess: a Temporal-journal teardown closes the beat, then collects, kills, ends the groups and only then hands the workspace back", async () => {
    const runId = nextRunId();
    const runDir = mkdtempSync(join(tmpdir(), "beat-close-release-"));
    try {
      const manifestPath = join(runDir, "manifest.json");
      writeRunManifest(manifestPath, manifestFor(runId, "working"));
      const journalFile = join(runDir, "governess-control.jsonl");
      const temporal = {
        address: environment.address,
        namespace: environment.namespace ?? "default",
        taskQueue: TASK_QUEUE,
      };
      const backend = await attachGovernessJournalBackend({
        connect: async () => journalClient(REPO),
        journalFile,
        ownerRepoId: REPO,
        runId,
        temporal,
      });
      // The beat workflow exists, as it does once the governess journaled.
      await startBeat(runId);
      expect(await statusOf(ownedId(runId))).toBe("RUNNING");
      const config = {
        agents: [],
        epoch: 1,
        journalBackend: backend,
        journalFile,
        journalTemporal: temporal,
        logFile: join(runDir, "governess.jsonl"),
        manifestPath,
        repoId: REPO,
        runDir,
        runId,
        session: `repo-beat-close-${runId}`,
      } as unknown as GovernessConfig;
      const base = defaultGovernessDeps();
      const order: string[] = [];
      await stopGovernessLoop(
        config,
        {
          ...base,
          appendLog: (_file: string, entry: unknown) =>
            order.push(`log:${(entry as { event: string }).event}`),
          cleanupRunProcesses: () => {
            order.push("cleanup");
            return { killed: [], skipped: [] };
          },
          closeBeatWorkflow: async (closing, reason) => {
            const closed = await base.closeBeatWorkflow?.(closing, reason);
            order.push(
              `closed:${closed?.outcome}:${await statusOf(ownedId(runId))}`
            );
            return closed;
          },
          collectAgentGroups: () => {
            order.push("collect");
            return {
              groups: [
                {
                  id: 9_999_001,
                  kind: "group",
                  reference: "2026-10-10T00:00:00.000Z",
                  source: "agent pane %1",
                },
              ],
              killed: [],
              skipped: [],
            };
          },
          fenceCurrent: () => true,
          killSession: () => order.push("kill"),
          markRunStopped: (stopping, reason) => {
            base.markRunStopped?.(stopping, reason);
            order.push(`mark:${readRunManifest(manifestPath)?.state}`);
          },
          now: () => Date.parse("2026-10-10T00:00:00.000Z"),
          releaseWorkspaceAfterTeardown: async () => {
            order.push(`release:${await statusOf(ownedId(runId))}`);
            return { detail: "changed", released: true };
          },
          terminateRunProcessGroups: (_ending, targets) => {
            order.push(`terminate:${targets.map((target) => target.id)}`);
            return Promise.resolve({
              exited: ["agent pane %1 process group 9999001"],
              failed: [],
              killed: [],
              survivors: [],
            });
          },
        },
        "user requested teardown"
      );
      expect(order.filter((entry) => !entry.startsWith("log:"))).toEqual([
        "mark:stopped",
        "cleanup",
        "closed:terminated:TERMINATED",
        "collect",
        "kill",
        "terminate:9999001",
        "release:TERMINATED",
      ]);
      expect(order).toContain("log:journal-temporal-closed");
      expect(order.at(-1)).toBe("log:workspace-released");
      // The teardown's later journal transitions stay in the file and never
      // reopen the closed workflow.
      expect(config.journalBackend).toBeUndefined();
      expect(await statusOf(ownedId(runId))).toBe("TERMINATED");
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });
});

describe("governess-beat close without a server", () => {
  const OWNED_7 = ownedId("7", REPO, DEFAULT_QUEUE);

  test("live: an active run is refused before the server is even described", async () => {
    for (const state of ACTIVE_STATES) {
      const control = fakeControl({
        [OWNED_7]: {
          memo: ownerMemo("7", REPO, DEFAULT_QUEUE),
          status: "RUNNING",
        },
      });
      const closed = await closeGovernessBeatWorkflow({
        control,
        manifest: manifestFor("7", state),
        reason: "test",
        repoId: REPO,
        runId: "7",
        taskQueue: DEFAULT_QUEUE,
      });
      expect(closed.outcome).toBe("refused-live");
      expect(control.calls).toEqual([]);
    }
  });

  test("live: a missing manifest or one naming another run is refused", async () => {
    const control = fakeControl({});
    const input = {
      control,
      reason: "test",
      repoId: REPO,
      runId: "7",
      taskQueue: DEFAULT_QUEUE,
    };
    expect(
      (await closeGovernessBeatWorkflow({ ...input, manifest: undefined }))
        .outcome
    ).toBe("refused-live");
    expect(
      (
        await closeGovernessBeatWorkflow({
          ...input,
          manifest: manifestFor("8", "stopped"),
        })
      ).outcome
    ).toBe("refused-live");
    expect(control.calls).toEqual([]);
  });

  test("close: a terminate that races a concurrent close is already-closed", async () => {
    const workflowId = ownedId("9", REPO, DEFAULT_QUEUE);
    const control: GovernessBeatWorkflowControl = {
      close: async () => undefined,
      describe: async (id) =>
        id === workflowId
          ? {
              executionRunId: "run-9",
              memo: ownerMemo("9", REPO, DEFAULT_QUEUE),
              status: "RUNNING",
              taskQueue: DEFAULT_QUEUE,
            }
          : undefined,
      terminate: () =>
        Promise.reject(
          Object.assign(new Error("gone"), { name: "WorkflowNotFoundError" })
        ),
    };
    expect(
      await closeGovernessBeatWorkflow({
        control,
        manifest: manifestFor("9", "stopped"),
        reason: "test",
        repoId: REPO,
        runId: "9",
        taskQueue: DEFAULT_QUEUE,
      })
    ).toEqual({
      detail: "closed concurrently",
      outcome: "already-closed",
      workflowId,
    });
  });

  test("no-op: unset settings never read runs or dial Temporal", async () => {
    let dialled = 0;
    let listed = 0;
    const result = await reconcileGovernessBeatWorkflows({
      connect: () => {
        dialled += 1;
        return Promise.reject(new Error("must not dial"));
      },
      env: {},
      listTmuxSessions: () => {
        listed += 1;
        return new Set();
      },
      repoId: REPO,
      storageRoot: "/nonexistent",
    });
    expect(result).toEqual({
      checked: 0,
      failed: 0,
      outcomes: {},
      skippedLive: 0,
    });
    expect(dialled).toBe(0);
    expect(listed).toBe(0);
    expect(
      await closeGovernessBeatForTerminalRun({
        connect: () => {
          dialled += 1;
          return Promise.reject(new Error("must not dial"));
        },
        env: {},
        manifest: manifestFor("3", "failed"),
        manifestPath: "/nonexistent/manifest.json",
        reason: "test",
        runId: "3",
      })
    ).toBeUndefined();
    expect(dialled).toBe(0);
  });

  test("reconcile: unknown tmux state keeps every tmux-owned run", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "beat-close-unknown-"));
    const runDir = join(storageRoot, REPO, "4");
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(
      join(runDir, "manifest.json"),
      manifestFor("4", "stopped", { tmuxSession: "maybe" })
    );
    let dialled = 0;
    const result = await reconcileGovernessBeatWorkflows({
      connect: () => {
        dialled += 1;
        return Promise.resolve(fakeControl({}));
      },
      env: TEMPORAL_ENV,
      listTmuxSessions: () => undefined,
      log: () => undefined,
      repoId: REPO,
      storageRoot,
    });
    expect(result.skippedLive).toBe(1);
    expect(dialled).toBe(0);
    rmSync(storageRoot, { force: true, recursive: true });
  });

  test("reconcile: an unreachable server is logged, never thrown", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "beat-close-down-"));
    const runDir = join(storageRoot, REPO, "5");
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(join(runDir, "manifest.json"), manifestFor("5", "failed"));
    const logs: string[] = [];
    const result = await reconcileGovernessBeatWorkflows({
      connect: () => Promise.reject(new Error("connection refused")),
      env: TEMPORAL_ENV,
      listTmuxSessions: () => new Set(),
      log: (line) => logs.push(line),
      repoId: REPO,
      storageRoot,
    });
    expect(result.failed).toBe(1);
    expect(logs.join("\n")).toContain("connection refused");
    rmSync(storageRoot, { force: true, recursive: true });
  });

  test("launcher: a live run is refused without dialling", async () => {
    let dialled = 0;
    const closed = await closeGovernessBeatForTerminalRun({
      connect: () => {
        dialled += 1;
        return Promise.resolve(fakeControl({}));
      },
      env: TEMPORAL_ENV,
      manifest: manifestFor("6", "working"),
      manifestPath: "/nonexistent/manifest.json",
      reason: "test",
      runId: "6",
    });
    expect(closed).toMatchObject({
      outcome: "refused-live",
      workflowId: ownedId("6", REPO, DEFAULT_QUEUE),
    });
    expect(dialled).toBe(0);
  });

  test("default (fix8): the close reads its server from the orchestration config, uses the per-host queue, and leaves the legacy execution on the old queue alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "beat-close-default-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        address: "192.0.2.10:7233",
        namespace: "harness",
        schema: "loop-orchestration-server.v1",
      })
    );
    const hostQueue = governessHostTaskQueue();
    const owned = ownedId("7", REPO, hostQueue);
    const legacy = governessBeatLegacyWorkflowId("7");
    const control = fakeControl({
      // A pre-fix8 run of this repo journalled on the old default queue.
      [legacy]: { memo: { loopRepoId: REPO }, status: "RUNNING" },
      [owned]: {
        memo: ownerMemo("7", REPO, hostQueue),
        status: "RUNNING",
        taskQueue: hostQueue,
      },
    });
    const dialled: string[] = [];
    try {
      const closed = await closeGovernessBeatForTerminalRun({
        connect: (config) => {
          dialled.push(
            `${config.address}/${config.namespace}/${config.taskQueue}`
          );
          return Promise.resolve(control);
        },
        env: { LOOP_ORCHESTRATION_CONFIG: configPath },
        manifest: manifestFor("7", "stopped"),
        manifestPath: "/nonexistent/manifest.json",
        reason: "test",
        runId: "7",
      });
      expect(dialled).toEqual([`192.0.2.10:7233/harness/${hostQueue}`]);
      expect(closed).toMatchObject({
        legacy: { outcome: "refused-foreign", workflowId: legacy },
        outcome: "terminated",
        workflowId: owned,
      });
      expect(control.calls).not.toContain(
        `terminate:${legacy}@run-of-${legacy}`
      );
      // Opted out: nothing is dialled even with the config present.
      expect(
        await closeGovernessBeatForTerminalRun({
          connect: () => Promise.reject(new Error("must not dial")),
          env: {
            LOOP_GOVERNESS_TEMPORAL: "off",
            LOOP_ORCHESTRATION_CONFIG: configPath,
          },
          manifest: manifestFor("7", "stopped"),
          manifestPath: "/nonexistent/manifest.json",
          reason: "test",
          runId: "7",
        })
      ).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("launcher: a failed run's owned workflow, and its owned legacy one, are terminated by exact run", async () => {
    const owned = ownedId("6", REPO, DEFAULT_QUEUE);
    const legacy = governessBeatLegacyWorkflowId("6");
    const control = fakeControl({
      [legacy]: { memo: { loopRepoId: REPO }, status: "RUNNING" },
      [owned]: { memo: ownerMemo("6", REPO, DEFAULT_QUEUE), status: "RUNNING" },
    });
    const closed = await closeGovernessBeatForTerminalRun({
      connect: () => Promise.resolve(control),
      env: TEMPORAL_ENV,
      manifest: manifestFor("6", "failed"),
      manifestPath: "/nonexistent/manifest.json",
      reason: "paired session start failed",
      runId: "6",
    });
    expect(closed).toEqual({
      legacy: { outcome: "terminated", workflowId: legacy },
      outcome: "terminated",
      workflowId: owned,
    });
    expect(control.calls).toEqual([
      `describe:${owned}`,
      `terminate:${owned}@run-of-${owned}`,
      `describe:${legacy}`,
      `terminate:${legacy}@run-of-${legacy}`,
      "close",
    ]);
  });
});

describe("governess teardown closes the beat", () => {
  const teardownConfig = (temporal: boolean): GovernessConfig =>
    ({
      agents: [
        { agent: "claude", hookFile: "claude", pane: "session:0.0" },
        { agent: "codex", hookFile: "codex", pane: "session:0.1" },
      ],
      driverEffort: "medium",
      epoch: 1,
      initialDriver: "claude",
      ...(temporal
        ? {
            journalTemporal: {
              address: "127.0.0.1:7233",
              namespace: "harness",
              taskQueue: "loop-governess",
            },
          }
        : {}),
      logFile: "/tmp/governess-beat-close-test.jsonl",
      reviewerEffort: "high",
      runDir: mkdtempSync(join(tmpdir(), "beat-close-teardown-")),
      runId: "11",
      session: "session",
    }) as GovernessConfig;

  const orderedDeps = (
    order: string[],
    close: (config: GovernessConfig, reason: string) => Promise<undefined>
  ) => ({
    ...defaultGovernessDeps(),
    appendLog: (_file: string, entry: unknown) =>
      order.push(`log:${(entry as { event: string }).event}`),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      return { killed: [], skipped: [] };
    },
    closeBeatWorkflow: close,
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    markRunStopped: () => order.push("mark"),
    now: () => 0,
  });

  test("governess: teardown closes after marking the run stopped and before killing the session", async () => {
    const order: string[] = [];
    await stopGovernessLoop(
      teardownConfig(true),
      orderedDeps(order, (_config, reason) => {
        order.push(`close:${reason}`);
        return Promise.resolve(undefined);
      }),
      "user requested teardown"
    );
    expect(order).toEqual([
      "log:exit",
      "mark",
      "cleanup",
      "close:user requested teardown",
      "log:journal-temporal-closed",
      "kill",
      // No run manifest in this config, so there is no handback to confirm.
      "log:workspace-release-deferred",
    ]);
  });

  test("governess: a failed close still kills the session", async () => {
    const order: string[] = [];
    await stopGovernessLoop(
      teardownConfig(true),
      orderedDeps(order, () => {
        order.push("close");
        return Promise.reject(new Error("server down"));
      }),
      "user requested teardown"
    );
    expect(order).toEqual([
      "log:exit",
      "mark",
      "cleanup",
      "close",
      "log:journal-temporal-close-failed",
      "kill",
      "log:workspace-release-deferred",
    ]);
  });

  test("no-op: without Temporal the teardown never closes and kills synchronously", () => {
    const order: string[] = [];
    const result = stopGovernessLoop(
      teardownConfig(false),
      orderedDeps(order, () => {
        order.push("close");
        return Promise.resolve(undefined);
      }),
      "user requested teardown"
    );
    expect(order).toEqual(["log:exit", "mark", "cleanup", "kill"]);
    expect(result).toBeInstanceOf(Promise);
  });
});

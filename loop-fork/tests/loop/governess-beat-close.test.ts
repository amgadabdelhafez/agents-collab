// A finished run closes its governess-beat workflow. Each named check fails if
// the thing it names is absent:
//
//   close        — a terminal run's RUNNING workflow is terminated on a real
//                  Temporal test server, and its journal is still readable.
//   live         — a run in any active state is never closed, and not even
//                  described.
//   ownership    — a workflow whose owner memo names another repo is refused;
//                  one with no memo is refused unless the run's own governess
//                  closes it.
//   reconcile    — startup closes completed, stopped and failed (abandoned)
//                  runs, skips live and tmux-alive runs, and a second pass
//                  closes nothing.
//   no-op        — with the Temporal settings unset nothing is dialled.
//   governess    — teardown closes after marking the run stopped and before
//                  killing its session, and the real default close detaches
//                  the journal sink first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  createGovernessBeatWorkflowControl,
  type GovernessBeatWorkflowControl,
  reconcileGovernessBeatWorkflows,
} from "../../src/loop/governess-beat-close";
import { governessBeatWorkflowId } from "../../src/loop/governess-beat-workflow";
import {
  prepareGovernessControl,
  readGovernessJournal,
} from "../../src/loop/governess-journal";
import type { GovernessControlRecord } from "../../src/loop/governess-journal-core";
import {
  attachGovernessJournalBackend,
  createGovernessTemporalJournalClient,
  GOVERNESS_BEAT_OWNER_MEMO_KEY,
  type GovernessTemporalJournalClient,
} from "../../src/loop/governess-temporal-journal";
import {
  createRunManifest,
  type RunManifest,
  readRunManifest,
  setRunManifestState,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { RunLifecycleState } from "../../src/loop/types";

const REPO = "repo-beat-close";
const OTHER_REPO = "repo-someone-else";
const TASK_QUEUE = `beat-close-${process.pid}`;
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

/** A control that records calls and serves a scripted server state. */
const fakeControl = (
  workflows: Record<string, { ownerRepoId?: string; status: string }>
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
      return Promise.resolve(workflows[workflowId]);
    },
    terminate: (workflowId) => {
      calls.push(`terminate:${workflowId}`);
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

  const journalClient = (
    ownerRepoId?: string
  ): GovernessTemporalJournalClient =>
    createGovernessTemporalJournalClient({
      client: environment.client.workflow,
      decode: (payload) =>
        defaultPayloadConverter.fromPayload(
          payload as Parameters<typeof defaultPayloadConverter.fromPayload>[0]
        ),
      ...(ownerRepoId ? { ownerRepoId } : {}),
      settleTimeoutMs: 2000,
      taskQueue: TASK_QUEUE,
    });

  const control = (): GovernessBeatWorkflowControl =>
    createGovernessBeatWorkflowControl({ client: environment.client.workflow });

  // Starts governess-beat:<runId> the way the live journal does. No worker
  // polls TASK_QUEUE, exactly as in production.
  const startBeat = async (
    runId: string,
    ownerRepoId: string | null = REPO
  ): Promise<void> => {
    await journalClient(ownerRepoId ?? undefined).appendRecord(
      runId,
      record("2026-09-18T00:00:00.000Z")
    );
  };

  const statusOf = async (runId: string): Promise<string> =>
    (
      await environment.client.workflow
        .getHandle(governessBeatWorkflowId(runId))
        .describe()
    ).status.name;

  const nextRunId = (): string => {
    sequence += 1;
    return `beat-close-${process.pid}-${sequence}`;
  };

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 180_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  test("close: the journal writes the owner memo when it creates the workflow", async () => {
    const runId = nextRunId();
    await startBeat(runId);
    const described = await environment.client.workflow
      .getHandle(governessBeatWorkflowId(runId))
      .describe();
    expect(described.memo?.[GOVERNESS_BEAT_OWNER_MEMO_KEY]).toBe(REPO);
  });

  for (const state of ["completed", "failed", "stopped"] as const) {
    test(`close: a ${state} run's running beat workflow is terminated and its journal stays readable`, async () => {
      const runId = nextRunId();
      await startBeat(runId);
      expect(await statusOf(runId)).toBe("RUNNING");
      const closed = await closeGovernessBeatWorkflow({
        control: control(),
        manifest: manifestFor(runId, state),
        reason: "test",
        repoId: REPO,
        requireOwnerMemo: true,
        runId,
      });
      expect(closed).toEqual({
        outcome: "terminated",
        workflowId: governessBeatWorkflowId(runId),
      });
      expect(await statusOf(runId)).toBe("TERMINATED");
      expect(await journalClient().readRecords(runId)).toHaveLength(1);
    });
  }

  for (const state of ACTIVE_STATES) {
    test(`live: a ${state} run's workflow is never closed`, async () => {
      const runId = nextRunId();
      await startBeat(runId);
      const closed = await closeGovernessBeatWorkflow({
        control: control(),
        manifest: manifestFor(runId, state),
        reason: "test",
        repoId: REPO,
        requireOwnerMemo: false,
        runId,
      });
      expect(closed.outcome).toBe("refused-live");
      expect(await statusOf(runId)).toBe("RUNNING");
    });
  }

  test("ownership: a workflow owned by another repo is refused", async () => {
    const runId = nextRunId();
    await startBeat(runId, OTHER_REPO);
    const closed = await closeGovernessBeatWorkflow({
      control: control(),
      manifest: manifestFor(runId, "stopped"),
      reason: "test",
      repoId: REPO,
      requireOwnerMemo: false,
      runId,
    });
    expect(closed.outcome).toBe("refused-foreign");
    expect(await statusOf(runId)).toBe("RUNNING");
  });

  test("ownership: an unowned workflow is refused unless the run's own governess closes it", async () => {
    const runId = nextRunId();
    await startBeat(runId, null);
    const input = {
      control: control(),
      manifest: manifestFor(runId, "stopped"),
      reason: "test",
      repoId: REPO,
      runId,
    };
    const refused = await closeGovernessBeatWorkflow({
      ...input,
      requireOwnerMemo: true,
    });
    expect(refused.outcome).toBe("refused-unowned");
    expect(await statusOf(runId)).toBe("RUNNING");
    const closed = await closeGovernessBeatWorkflow({
      ...input,
      requireOwnerMemo: false,
    });
    expect(closed.outcome).toBe("terminated");
    expect(await statusOf(runId)).toBe("TERMINATED");
  });

  test("close: absent and already-closed workflows are no-ops", async () => {
    const absentRun = nextRunId();
    expect(
      (
        await closeGovernessBeatWorkflow({
          control: control(),
          manifest: manifestFor(absentRun, "stopped"),
          reason: "test",
          repoId: REPO,
          requireOwnerMemo: true,
          runId: absentRun,
        })
      ).outcome
    ).toBe("absent");
    const runId = nextRunId();
    await startBeat(runId);
    const input = {
      control: control(),
      manifest: manifestFor(runId, "stopped"),
      reason: "test",
      repoId: REPO,
      requireOwnerMemo: true,
      runId,
    };
    expect((await closeGovernessBeatWorkflow(input)).outcome).toBe(
      "terminated"
    );
    const again = await closeGovernessBeatWorkflow(input);
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
    const reconcile = () =>
      reconcileGovernessBeatWorkflows({
        connect: async () => control(),
        env: TEMPORAL_ENV,
        listTmuxSessions: () => new Set(["live-session"]),
        log: () => undefined,
        repoId: REPO,
        storageRoot,
      });

    const first = await reconcile();
    expect(first).toEqual({
      checked: 3,
      failed: 0,
      outcomes: { terminated: 3 },
      skippedLive: 1,
    });
    expect(await statusOf(runs.completed)).toBe("TERMINATED");
    expect(await statusOf(runs.stopped)).toBe("TERMINATED");
    expect(await statusOf(runs.abandoned)).toBe("TERMINATED");
    expect(await statusOf(runs.working)).toBe("RUNNING");
    expect(await statusOf(runs.liveTmux)).toBe("RUNNING");

    const second = await reconcile();
    expect(second).toEqual({
      checked: 3,
      failed: 0,
      outcomes: { "already-closed": 3 },
      skippedLive: 1,
    });
    expect(await statusOf(runs.working)).toBe("RUNNING");
    rmSync(storageRoot, { force: true, recursive: true });
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
    expect(await statusOf(runId)).toBe("RUNNING");

    writeRunManifest(
      manifestPath,
      setRunManifestState(
        readRunManifest(manifestPath) as RunManifest,
        "stopped"
      )
    );
    const closed = await close?.(config, "user requested teardown");
    expect(closed?.outcome).toBe("terminated");
    expect(await statusOf(runId)).toBe("TERMINATED");
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
    expect(await statusOf(runId)).toBe("TERMINATED");
    rmSync(runDir, { force: true, recursive: true });
  });
});

describe("governess-beat close without a server", () => {
  test("live: an active run is refused before the server is even described", async () => {
    for (const state of ACTIVE_STATES) {
      const control = fakeControl({
        [governessBeatWorkflowId("7")]: {
          ownerRepoId: REPO,
          status: "RUNNING",
        },
      });
      const closed = await closeGovernessBeatWorkflow({
        control,
        manifest: manifestFor("7", state),
        reason: "test",
        repoId: REPO,
        requireOwnerMemo: false,
        runId: "7",
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
      requireOwnerMemo: false,
      runId: "7",
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
    const workflowId = governessBeatWorkflowId("9");
    const control: GovernessBeatWorkflowControl = {
      close: async () => undefined,
      describe: async () => ({ ownerRepoId: REPO, status: "RUNNING" }),
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
        requireOwnerMemo: true,
        runId: "9",
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
    expect(closed?.outcome).toBe("refused-live");
    expect(dialled).toBe(0);
  });

  test("launcher: a failed run's owned workflow is terminated", async () => {
    const control = fakeControl({
      [governessBeatWorkflowId("6")]: { ownerRepoId: REPO, status: "RUNNING" },
    });
    const closed = await closeGovernessBeatForTerminalRun({
      connect: () => Promise.resolve(control),
      env: TEMPORAL_ENV,
      manifest: manifestFor("6", "failed"),
      manifestPath: "/nonexistent/manifest.json",
      reason: "paired session start failed",
      runId: "6",
    });
    expect(closed?.outcome).toBe("terminated");
    expect(control.calls).toEqual([
      `describe:${governessBeatWorkflowId("6")}`,
      `terminate:${governessBeatWorkflowId("6")}`,
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

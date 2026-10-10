// gov-6 write-through proofs. Each named check fails if the thing it names is
// absent:
//
//   golden     — the fixture journal written through the Temporal path equals
//                the golden, both as read back from history and as held in the
//                running workflow's state.
//   recovery   — after the governess pane dies and its file journal is lost,
//                the next start reads the journal back from Temporal and the
//                idempotency fence still holds.
//   fallback   — with no Temporal configured, the file journal works and the
//                Temporal connector is never called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  governessBeatLegacyWorkflowId,
  governessBeatOwnedWorkflowId,
  governessBeatOwner,
  governessBeatOwnerMemo,
} from "../../src/loop/governess-beat-identity";
import { GOVERNESS_BEAT_WORKFLOW_TYPE } from "../../src/loop/governess-beat-workflow";
import {
  compactGovernessJournal,
  prepareGovernessControl,
  readGovernessJournal,
  recordGovernessObservation,
  serializeGovernessJournal,
  transitionGovernessControl,
} from "../../src/loop/governess-journal";
import type { GovernessControlRecord } from "../../src/loop/governess-journal-core";
import {
  attachGovernessJournalBackend,
  createGovernessTemporalJournalClient,
  type GovernessTemporalConfig,
  type GovernessTemporalJournalClient,
  governessJournalFromHistoryEvents,
  governessTemporalConfigFromEnv,
  recoverGovernessJournalFromTemporal,
} from "../../src/loop/governess-temporal-journal";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import {
  applyGovernessFixture,
  GOVERNESS_FIXTURE,
  GOVERNESS_FIXTURE_PROMPT_BODY,
} from "./governess-beat-fixture";

const GOLDEN = "tests/fixtures/governess/beat-journal.golden.jsonl";
const REPO_A = "repo-a-00000000000a";
const REPO_B = "repo-b-00000000000b";
const TEST_CONFIG: GovernessTemporalConfig = {
  address: "unused-by-injected-connect:7233",
  namespace: "unused",
  taskQueue: `gov6-journal-${process.pid}`,
};

const goldenRecords = (): GovernessControlRecord[] =>
  readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GovernessControlRecord);

// Control ids are the one legitimately random field in the file writer, so the
// golden comparison aliases them by first appearance and compares everything
// else byte for byte.
const normalize = (records: readonly GovernessControlRecord[]): string => {
  const ids = new Map<string, string>();
  return records
    .map((record) => {
      if (!ids.has(record.controlId)) {
        ids.set(record.controlId, `control-${ids.size + 1}`);
      }
      return JSON.stringify({
        ...record,
        controlId: ids.get(record.controlId),
      });
    })
    .join("\n");
};

const writeFixture = (journalFile: string): void => {
  applyGovernessFixture(
    {
      prepareGovernessControl: (file, input) =>
        prepareGovernessControl(
          file,
          input as Parameters<typeof prepareGovernessControl>[1]
        ),
      recordGovernessObservation: (file, input) =>
        recordGovernessObservation(
          file,
          input as Parameters<typeof recordGovernessObservation>[1]
        ),
      transitionGovernessControl: (
        file,
        controlId,
        phase,
        at,
        reason,
        details
      ) =>
        transitionGovernessControl(
          file,
          controlId,
          phase as GovernessControlRecord["phase"],
          at,
          reason,
          details as Parameters<typeof transitionGovernessControl>[5]
        ),
    },
    journalFile,
    GOVERNESS_FIXTURE
  );
};

// The error text a call failed with, or "resolved". Awaited directly rather
// than through expect().rejects, which stalled the gRPC client for about 45 s
// per call under bun here.
const refusal = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const freshJournal = (): string =>
  join(mkdtempSync(join(tmpdir(), "gov6-temporal-journal-")), "journal.jsonl");

describe("gov-6 governess journal on Temporal", () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;

  const journalClient = (
    ownerRepoId = REPO_A,
    taskQueue = TEST_CONFIG.taskQueue
  ): GovernessTemporalJournalClient =>
    createGovernessTemporalJournalClient({
      client: environment.client.workflow,
      decode: (payload) =>
        defaultPayloadConverter.fromPayload(
          payload as Parameters<typeof defaultPayloadConverter.fromPayload>[0]
        ),
      ownerRepoId,
      settleTimeoutMs: 10_000,
      taskQueue,
    });

  const ownedId = (
    runId: string,
    repoId = REPO_A,
    taskQueue = TEST_CONFIG.taskQueue
  ): string =>
    governessBeatOwnedWorkflowId(
      governessBeatOwner({ repoId, runId, taskQueue })
    );

  // Signal events in an id's latest run: everything ever written to it.
  const signalCount = async (workflowId: string): Promise<number> =>
    (
      (await environment.client.workflow.getHandle(workflowId).fetchHistory())
        .events ?? []
    ).filter((event) => event.workflowExecutionSignaledEventAttributes).length;

  // An execution created the way an older journal, or another owner, would:
  // signalWithStart under whatever id, memo and queue the caller chose.
  const plantBeat = async (input: {
    memo?: Record<string, string>;
    record: GovernessControlRecord;
    runId: string;
    taskQueue: string;
    workflowId: string;
  }): Promise<void> => {
    await environment.client.workflow.signalWithStart("temporalWorkflow", {
      args: [
        {
          at: input.record.at,
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
          at: input.record.at,
          kind: "signal",
          name: "append_record",
          payload: { record: input.record },
          requestId: `append:${input.record.sequence}:planted`,
        },
      ],
      taskQueue: input.taskQueue,
      workflowId: input.workflowId,
    });
  };

  const queryWorkflowJournal = async (
    runId: string
  ): Promise<GovernessControlRecord[]> => {
    const port = new TemporalWorkflowPort(environment.client.workflow, {
      taskQueue: TEST_CONFIG.taskQueue,
    });
    const queried = await port.query({
      name: "journal",
      workflowId: ownedId(runId),
    });
    return queried.value as unknown as GovernessControlRecord[];
  };

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: TEST_CONFIG.taskQueue,
      workflowBundle: {
        code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
          "utf8"
        ),
      },
    });
    workerRun = worker.run();
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await environment?.teardown();
  });

  test("golden: the fixture journal replays identically through the Temporal path", async () => {
    const runId = `gov6-golden-${process.pid}`;
    const journalFile = freshJournal();
    const backend = await attachGovernessJournalBackend({
      connect: async () => journalClient(),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    expect(backend.kind).toBe("temporal");
    writeFixture(journalFile);
    await backend.close();

    const golden = goldenRecords();
    const fromFile = readGovernessJournal(journalFile);
    const fromHistory = await journalClient().readRecords(runId);
    const fromWorkflow = await queryWorkflowJournal(runId);

    // A fixture with no decisions would make every equality below vacuous.
    expect(golden.length).toBeGreaterThan(5);
    expect(normalize(fromFile)).toBe(normalize(golden));
    // History and the running workflow hold the file's exact records,
    // control ids included, not merely the same shape.
    expect(serializeGovernessJournal(fromHistory)).toBe(
      serializeGovernessJournal(fromFile)
    );
    expect(serializeGovernessJournal(fromWorkflow)).toBe(
      serializeGovernessJournal(fromFile)
    );
    expect(JSON.stringify(fromHistory)).not.toContain(
      GOVERNESS_FIXTURE_PROMPT_BODY
    );
  }, 120_000);

  test("recovery: a dead governess pane's journal is read back from Temporal", async () => {
    const runId = `gov6-recovery-${process.pid}`;
    const journalFile = freshJournal();
    const first = await attachGovernessJournalBackend({
      connect: async () => journalClient(),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    writeFixture(journalFile);
    await first.close();
    const beforeDeath = readGovernessJournal(journalFile);

    // The pane dies and takes its run-dir journal and index with it.
    rmSync(journalFile, { force: true });
    rmSync(`${journalFile}.index.json`, { force: true });
    expect(readGovernessJournal(journalFile)).toEqual([]);

    const second = await attachGovernessJournalBackend({
      connect: async () => journalClient(),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    if (second.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    expect(second.recovery).toMatchObject({
      backfilled: 0,
      fileRecords: 0,
      rewroteFile: true,
      temporalRecords: beforeDeath.length,
    });
    expect(serializeGovernessJournal(readGovernessJournal(journalFile))).toBe(
      serializeGovernessJournal(beforeDeath)
    );

    // Recovered state, not just bytes: the idempotency fence answers from the
    // recovered log instead of issuing the control a second time.
    const held = beforeDeath.find((record) => record.action === "nudge");
    if (!held) {
      throw new Error("fixture has no nudge control to re-fence");
    }
    const again = prepareGovernessControl(journalFile, {
      action: held.action,
      at: "2026-09-02T00:00:00.000Z",
      epoch: held.epoch,
      idempotencyKey: held.idempotencyKey,
      payload: "re-issued after recovery",
      policyClass: held.policyClass,
    });
    expect(again.controlId).toBe(held.controlId);
    await second.close();
    expect(await journalClient().readRecords(runId)).toHaveLength(
      beforeDeath.length
    );
  }, 120_000);

  test("recovery: records the dying pane never signalled are replayed into Temporal", async () => {
    const runId = `gov6-backfill-${process.pid}`;
    const journalFile = freshJournal();
    let allowed = 3;
    const flaky = journalClient();
    const first = await attachGovernessJournalBackend({
      connect: async () => ({
        ...flaky,
        appendRecord: async (id, record) => {
          if (allowed <= 0) {
            throw new Error("server went away");
          }
          allowed -= 1;
          await flaky.appendRecord(id, record);
        },
      }),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    writeFixture(journalFile);
    await first.close();
    const fileRecords = readGovernessJournal(journalFile);
    expect(await journalClient().readRecords(runId)).toHaveLength(3);

    const second = await attachGovernessJournalBackend({
      connect: async () => journalClient(),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    if (second.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    expect(second.recovery.backfilled).toBe(fileRecords.length - 3);
    await second.close();
    expect(
      serializeGovernessJournal(await journalClient().readRecords(runId))
    ).toBe(serializeGovernessJournal(fileRecords));
  }, 120_000);

  test("recovery: records compaction archived before they reached Temporal are still replayed", async () => {
    const runId = `gov6-compacted-${process.pid}`;
    const journalFile = freshJournal();
    const offline = journalClient();
    const first = await attachGovernessJournalBackend({
      connect: async () => ({
        ...offline,
        appendRecord: () => Promise.reject(new Error("server unreachable")),
      }),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    writeFixture(journalFile);
    await first.close();
    const everything = readGovernessJournal(journalFile);
    const compaction = compactGovernessJournal(journalFile);
    // Without archived records the replayed tail would have sequence holes.
    expect(compaction.archivedRecords).toBeGreaterThan(0);
    expect(readGovernessJournal(journalFile).length).toBeLessThan(
      everything.length
    );

    const second = await attachGovernessJournalBackend({
      connect: async () => journalClient(),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    if (second.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    await second.close();
    expect(second.recovery).toMatchObject({
      backfilled: everything.length,
      historyComplete: true,
      temporalRecords: everything.length,
    });
    expect(
      serializeGovernessJournal(await journalClient().readRecords(runId))
    ).toBe(serializeGovernessJournal(everything));
  }, 120_000);

  // fix7: the P1 cross-repo collision. Both repos use the same run id, the
  // same namespace and the same task queue, which is exactly what two repos
  // on one host with the default queue do.
  test("isolation: two repos with the same run id sharing a namespace and queue keep separate journals", async () => {
    const runId = `gov7-shared-${process.pid}`;
    const fileA = freshJournal();
    const fileB = freshJournal();
    const a = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO_A),
      journalFile: fileA,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    writeFixture(fileA);
    await a.close();

    const b = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO_B),
      journalFile: fileB,
      ownerRepoId: REPO_B,
      runId,
      temporal: TEST_CONFIG,
    });
    if (b.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    // B's recovery saw none of A's records and rewrote nothing.
    expect(b.recovery).toMatchObject({
      backfilled: 0,
      rewroteFile: false,
      temporalRecords: 0,
    });
    expect(readGovernessJournal(fileB)).toEqual([]);
    prepareGovernessControl(fileB, {
      action: "nudge",
      at: "2026-10-10T00:00:00.000Z",
      epoch: 1,
      idempotencyKey: "repo-b-only",
      payload: "repo b's own control",
      policyClass: "safe-automatic",
    });
    await b.close();

    const recordsA = readGovernessJournal(fileA);
    const recordsB = readGovernessJournal(fileB);
    expect(recordsA.length).toBeGreaterThan(5);
    expect(recordsB).toHaveLength(1);
    expect(ownedId(runId, REPO_A)).not.toBe(ownedId(runId, REPO_B));
    expect(
      serializeGovernessJournal(await journalClient(REPO_A).readRecords(runId))
    ).toBe(serializeGovernessJournal(recordsA));
    expect(
      serializeGovernessJournal(await journalClient(REPO_B).readRecords(runId))
    ).toBe(serializeGovernessJournal(recordsB));
    // Every signal each execution ever received is its own repo's.
    expect(await signalCount(ownedId(runId, REPO_A))).toBe(recordsA.length);
    expect(await signalCount(ownedId(runId, REPO_B))).toBe(1);
    for (const repoId of [REPO_A, REPO_B]) {
      const described = await environment.client.workflow
        .getHandle(ownedId(runId, repoId))
        .describe();
      expect(described.memo).toEqual(
        governessBeatOwnerMemo(
          governessBeatOwner({
            repoId,
            runId,
            taskQueue: TEST_CONFIG.taskQueue,
          })
        )
      );
    }
    // The legacy id both would have shared was never created.
    expect(
      await refusal(
        environment.client.workflow
          .getHandle(governessBeatLegacyWorkflowId(runId))
          .describe()
      )
    ).toContain("not found");
  }, 120_000);

  test("isolation: one repo and run under two deployments (task queues) keep separate journals", async () => {
    const runId = `gov7-deployments-${process.pid}`;
    const otherQueue = `${TEST_CONFIG.taskQueue}-elsewhere`;
    const here = freshJournal();
    const there = freshJournal();
    const first = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO_A),
      journalFile: here,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    writeFixture(here);
    await first.close();
    const second = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO_A, otherQueue),
      journalFile: there,
      ownerRepoId: REPO_A,
      runId,
      temporal: { ...TEST_CONFIG, taskQueue: otherQueue },
    });
    if (second.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    expect(second.recovery.temporalRecords).toBe(0);
    expect(second.workflowId).toBe(ownedId(runId, REPO_A, otherQueue));
    await second.close();
    expect(readGovernessJournal(there)).toEqual([]);
    expect(await signalCount(ownedId(runId, REPO_A))).toBe(
      readGovernessJournal(here).length
    );
  }, 120_000);

  test("ownership: an execution under this run's id that another owner holds is never signalled or read", async () => {
    const [seed] = goldenRecords();
    if (!seed) {
      throw new Error("golden journal is empty");
    }
    // Same id, this queue, but the memo names another repo.
    const squatted = `gov7-squatted-${process.pid}`;
    await plantBeat({
      memo: governessBeatOwnerMemo(
        governessBeatOwner({
          repoId: REPO_B,
          runId: squatted,
          taskQueue: TEST_CONFIG.taskQueue,
        })
      ),
      record: seed,
      runId: squatted,
      taskQueue: TEST_CONFIG.taskQueue,
      workflowId: ownedId(squatted),
    });
    // Same id and this owner's memo, but another deployment's queue.
    const queued = `gov7-queued-${process.pid}`;
    await plantBeat({
      memo: governessBeatOwnerMemo(
        governessBeatOwner({
          repoId: REPO_A,
          runId: queued,
          taskQueue: TEST_CONFIG.taskQueue,
        })
      ),
      record: seed,
      runId: queued,
      taskQueue: `${TEST_CONFIG.taskQueue}-foreign`,
      workflowId: ownedId(queued),
    });
    // Same id, this queue, no memo at all.
    const unowned = `gov7-unowned-${process.pid}`;
    await plantBeat({
      record: seed,
      runId: unowned,
      taskQueue: TEST_CONFIG.taskQueue,
      workflowId: ownedId(unowned),
    });

    for (const runId of [squatted, queued, unowned]) {
      const client = journalClient(REPO_A);
      expect(await refusal(client.appendRecord(runId, seed))).toContain(
        `${ownedId(runId)} is not this run's journal`
      );
      expect(await refusal(client.readRecords(runId))).toContain(
        "is not this run's journal"
      );
      // A governess start refuses instead of adopting the foreign journal.
      expect(
        await refusal(
          attachGovernessJournalBackend({
            connect: async () => journalClient(REPO_A),
            journalFile: freshJournal(),
            ownerRepoId: REPO_A,
            runId,
            temporal: TEST_CONFIG,
          })
        )
      ).toContain("is not this run's journal");
      expect(await signalCount(ownedId(runId))).toBe(1);
    }
  }, 120_000);

  test("legacy: an in-flight legacy execution of the same run is neither read nor signalled", async () => {
    const runId = `gov7-legacy-${process.pid}`;
    const [seed] = goldenRecords();
    if (!seed) {
      throw new Error("golden journal is empty");
    }
    // What the pre-fix7 journal left: governess-beat:<runId>, repo memo only.
    await plantBeat({
      memo: { loopRepoId: REPO_A },
      record: seed,
      runId,
      taskQueue: TEST_CONFIG.taskQueue,
      workflowId: governessBeatLegacyWorkflowId(runId),
    });
    const journalFile = freshJournal();
    const backend = await attachGovernessJournalBackend({
      connect: async () => journalClient(REPO_A),
      journalFile,
      ownerRepoId: REPO_A,
      runId,
      temporal: TEST_CONFIG,
    });
    if (backend.kind !== "temporal") {
      throw new Error("expected the Temporal backend");
    }
    expect(backend.recovery.temporalRecords).toBe(0);
    writeFixture(journalFile);
    await backend.close();
    expect(await signalCount(governessBeatLegacyWorkflowId(runId))).toBe(1);
    expect(
      serializeGovernessJournal(await journalClient(REPO_A).readRecords(runId))
    ).toBe(serializeGovernessJournal(readGovernessJournal(journalFile)));
  }, 120_000);
});

describe("gov-6 journal authority and fallback", () => {
  test("fallback: with no Temporal configured the file journal works and nothing dials out", async () => {
    expect(governessTemporalConfigFromEnv({})).toBeUndefined();
    let connectCalls = 0;
    const journalFile = freshJournal();
    const backend = await attachGovernessJournalBackend({
      connect: () => {
        connectCalls += 1;
        throw new Error("the file-only journal must not connect");
      },
      journalFile,
      runId: "gov6-fallback",
      temporal: governessTemporalConfigFromEnv({}),
    });
    expect(backend.kind).toBe("file");
    writeFixture(journalFile);
    await backend.close();
    expect(connectCalls).toBe(0);
    expect(normalize(readGovernessJournal(journalFile))).toBe(
      normalize(goldenRecords())
    );
  });

  test("a half-configured Temporal journal is an error, not a silent fallback", () => {
    expect(() =>
      governessTemporalConfigFromEnv({
        LOOP_GOVERNESS_TEMPORAL_ADDRESS: "192.168.1.18:7233",
      })
    ).toThrow("needs both");
    expect(
      governessTemporalConfigFromEnv({
        LOOP_GOVERNESS_TEMPORAL_ADDRESS: "192.168.1.18:7233",
        LOOP_GOVERNESS_TEMPORAL_NAMESPACE: "harness",
      })
    ).toEqual({
      address: "192.168.1.18:7233",
      namespace: "harness",
      taskQueue: "loop-governess",
    });
  });

  test("history wins when it disagrees with the file at a held sequence", async () => {
    const journalFile = freshJournal();
    writeFixture(journalFile);
    const fileRecords = readGovernessJournal(journalFile);
    const history = fileRecords
      .slice(0, 2)
      .map((record, index) =>
        index === 1 ? { ...record, reason: "history's version" } : record
      );
    const appended: GovernessControlRecord[] = [];
    const recovery = await recoverGovernessJournalFromTemporal(
      journalFile,
      "gov6-diverged",
      {
        appendRecord: (_runId, record) => {
          appended.push(record);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        readRecords: () => Promise.resolve(history),
        workflowId: governessBeatLegacyWorkflowId,
      }
    );
    expect(recovery.divergedAt).toBe(2);
    expect(appended).toEqual([]);
    expect(readGovernessJournal(journalFile)).toEqual(history);
  });

  test("history holding a record signal the reader does not fold is an error, not a short journal", () => {
    const signal = (name: string, payload: unknown) => ({
      workflowExecutionSignaledEventAttributes: {
        input: { payloads: [{ name, payload }] },
        signalName: "workflow-port-command",
      },
    });
    const decode = (payload: unknown) => {
      const { name, payload: body } = payload as {
        name: string;
        payload: unknown;
      };
      return { kind: "signal", name, payload: body };
    };
    const [first] = goldenRecords();
    expect(
      governessJournalFromHistoryEvents(
        [signal("append_record", { record: first })],
        decode
      )
    ).toEqual([first]);
    for (const name of [
      "prepare_control",
      "record_observation",
      "transition_control",
    ]) {
      expect(() =>
        governessJournalFromHistoryEvents(
          [signal("append_record", { record: first }), signal(name, {})],
          decode
        )
      ).toThrow(name);
    }
  });
});

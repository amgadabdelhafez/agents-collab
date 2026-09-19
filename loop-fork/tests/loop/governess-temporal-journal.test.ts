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
import { governessBeatWorkflowId } from "../../src/loop/governess-beat-workflow";
import {
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

const freshJournal = (): string =>
  join(mkdtempSync(join(tmpdir(), "gov6-temporal-journal-")), "journal.jsonl");

describe("gov-6 governess journal on Temporal", () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;

  const journalClient = (): GovernessTemporalJournalClient =>
    createGovernessTemporalJournalClient({
      client: environment.client.workflow,
      decode: (payload) =>
        defaultPayloadConverter.fromPayload(
          payload as Parameters<typeof defaultPayloadConverter.fromPayload>[0]
        ),
      taskQueue: TEST_CONFIG.taskQueue,
    });

  const queryWorkflowJournal = async (
    runId: string
  ): Promise<GovernessControlRecord[]> => {
    const port = new TemporalWorkflowPort(environment.client.workflow, {
      taskQueue: TEST_CONFIG.taskQueue,
    });
    const queried = await port.query({
      name: "journal",
      workflowId: governessBeatWorkflowId(runId),
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
        workflowId: governessBeatWorkflowId,
      }
    );
    expect(recovery.divergedAt).toBe(2);
    expect(appended).toEqual([]);
    expect(readGovernessJournal(journalFile)).toEqual(history);
  });
});

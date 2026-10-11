// gov-6 proof suite. Three named checks, each of which must fail if the
// behaviour regresses:
//
//   1. deterministic replay from history  — same fixture twice, identical
//      decision sequence.
//   2. journal equality                   — the exported read model equals the
//      pre-refactor JSONL journal, compared by content.
//   3. audit contract                     — no prompt body appears anywhere in
//      the history event set, signal payloads included.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  exportGovernessJournal,
  GOVERNESS_BEAT_WORKFLOW_TYPE,
  governessBeatWorkflowDefinition,
  governessBeatWorkflowId,
} from "../../src/loop/governess-beat-workflow";
import {
  governessJournalFromHistory,
  prepareGovernessControl,
  recordGovernessObservation,
  serializeGovernessJournal,
  transitionGovernessControl,
} from "../../src/loop/governess-journal";
import {
  decideGovernessPrepare,
  emptyGovernessControlState,
  type GovernessControlRecord,
} from "../../src/loop/governess-journal-core";
import { runGovernessUtilityCommand } from "../../src/loop/governess-replay";
import { governessHostTaskQueue } from "../../src/loop/governess-temporal-journal";
import { loadRunState } from "../../src/loop/run-state";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import type { JsonObject } from "../../src/loop/workflow-port";
import {
  applyGovernessFixture,
  GOVERNESS_FIXTURE,
  GOVERNESS_FIXTURE_PROMPT_BODY,
  type GovernessFixtureBeat,
} from "./governess-beat-fixture";

const GOLDEN = "tests/fixtures/governess/beat-journal.golden.jsonl";
const RUN_ID = "gov6-fixture-run";

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Drive the fixture through the pure beat definition, mirroring exactly what the
 * workflow does when it receives the same signals. Control ids come from a
 * deterministic counter so two runs are comparable.
 */
const reduceFixture = async (
  beats: readonly GovernessFixtureBeat[]
): Promise<{ records: GovernessControlRecord[]; signals: JsonObject[] }> => {
  let state = governessBeatWorkflowDefinition.start(
    { runId: RUN_ID },
    {
      at: "2026-09-01T00:00:00.000Z",
      nextRevision: 1,
      requestId: "start",
      workflowId: governessBeatWorkflowId(RUN_ID),
    }
  ).state;
  const controlIds = new Map<string, string>();
  const signals: JsonObject[] = [];
  let counter = 0;
  const nextControlId = (): string => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };

  for (const beat of beats) {
    let name: string;
    let payload: JsonObject;
    if (beat.kind === "prepare") {
      name = "prepare_control";
      payload = {
        action: beat.action,
        ...(beat.agent ? { agent: beat.agent } : {}),
        at: beat.at,
        controlId: nextControlId(),
        epoch: beat.epoch,
        idempotencyKey: beat.idempotencyKey,
        // The audit contract: the body is hashed before it ever becomes a signal.
        payloadHash: await sha256(beat.payload),
        policyClass: beat.policyClass,
      };
    } else if (beat.kind === "observe") {
      name = "record_observation";
      payload = {
        ...(beat.agent ? { agent: beat.agent } : {}),
        at: beat.at,
        controlId: nextControlId(),
        epoch: beat.epoch,
        ...(beat.heartbeatMs === undefined
          ? {}
          : { heartbeatMs: beat.heartbeatMs }),
        idempotencyKey: beat.idempotencyKey,
        payload: beat.payload,
        payloadHash: await sha256(beat.payload),
        policyClass: beat.policyClass,
        semanticHash: await sha256(beat.semanticPayload ?? beat.payload),
        stream: beat.stream,
      };
    } else {
      const controlId = controlIds.get(beat.controlRef);
      if (!controlId) {
        throw new Error(
          `fixture references unknown control ${beat.controlRef}`
        );
      }
      name = "transition_control";
      payload = {
        at: beat.at,
        controlId,
        ...(beat.reason ? { reason: beat.reason } : {}),
        details: {
          ...(beat.evidence ? { evidence: beat.evidence } : {}),
          ...(beat.transport ? { transport: beat.transport } : {}),
        },
        phase: beat.phase,
      };
    }

    signals.push({ name, payload });
    const transition = governessBeatWorkflowDefinition.signal(
      state,
      name,
      payload,
      {
        at: beat.at,
        nextRevision: signals.length + 1,
        requestId: `req-${signals.length}`,
        workflowId: governessBeatWorkflowId(RUN_ID),
      }
    );
    state = transition.state;
    if (beat.kind === "prepare") {
      const decided = transition.result as GovernessControlRecord | undefined;
      if (decided) {
        controlIds.set(beat.idempotencyKey, decided.controlId);
      }
    }
  }
  return { records: exportGovernessJournal(state), signals };
};

describe("gov-6 governess beat workflow", () => {
  test("check 1: replays deterministically from history", async () => {
    const first = await reduceFixture(GOVERNESS_FIXTURE);
    const second = await reduceFixture(GOVERNESS_FIXTURE);

    const decisionSequence = (records: GovernessControlRecord[]): string =>
      records
        .map(
          (record) =>
            `${record.sequence}|${record.action}|${record.phase}|${record.idempotencyKey}|${record.payloadHash}`
        )
        .join("\n");

    expect(decisionSequence(second.records)).toBe(
      decisionSequence(first.records)
    );
    expect(second.records).toEqual(first.records);
    // A fixture that produced no decisions would make this check vacuous.
    expect(first.records.length).toBeGreaterThan(0);
  });

  test("check 2: exported journal equals the pre-refactor JSONL journal by content", async () => {
    const golden = readFileSync(GOLDEN, "utf8");
    const goldenRecords = golden
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GovernessControlRecord);

    // The current JSONL writer must still produce the golden byte-for-byte.
    const dir = mkdtempSync(join(tmpdir(), "gov6-journal-"));
    const file = join(dir, "governess-control.jsonl");
    const writerControlIds: string[] = [];
    applyGovernessFixture(
      {
        prepareGovernessControl: (journalFile, input) => {
          const record = prepareGovernessControl(
            journalFile,
            input as Parameters<typeof prepareGovernessControl>[1]
          );
          writerControlIds.push(record.controlId);
          return record;
        },
        recordGovernessObservation: (journalFile, input) =>
          recordGovernessObservation(
            journalFile,
            input as Parameters<typeof recordGovernessObservation>[1]
          ),
        transitionGovernessControl: (
          journalFile,
          controlId,
          phase,
          at,
          reason,
          details
        ) =>
          transitionGovernessControl(
            journalFile,
            controlId,
            phase as GovernessControlRecord["phase"],
            at,
            reason,
            details as Parameters<typeof transitionGovernessControl>[5]
          ),
      },
      file,
      GOVERNESS_FIXTURE
    );
    const written = readFileSync(file, "utf8");

    // Control ids are the one legitimately non-deterministic field, so compare
    // every record by content with the id normalized away.
    const normalize = (records: GovernessControlRecord[]): string => {
      const ids = new Map<string, string>();
      return records
        .map((record) => {
          const alias =
            ids.get(record.controlId) ??
            ids
              .set(record.controlId, `control-${ids.size + 1}`)
              .get(record.controlId);
          return JSON.stringify({ ...record, controlId: alias });
        })
        .join("\n");
    };

    const writtenRecords = written
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GovernessControlRecord);
    expect(normalize(writtenRecords)).toBe(normalize(goldenRecords));

    // And the read model exported from workflow state must equal that same
    // journal, again by content rather than by line count.
    const { records } = await reduceFixture(GOVERNESS_FIXTURE);
    const exported = governessJournalFromHistory(records);
    expect(normalize(exported)).toBe(normalize(goldenRecords));
    expect(exported).toHaveLength(goldenRecords.length);
    expect(
      serializeGovernessJournal(exported).split("\n").filter(Boolean)
    ).toHaveLength(goldenRecords.length);
  });

  test("check 3: no prompt body appears in any history event or signal payload", async () => {
    const { records, signals } = await reduceFixture(GOVERNESS_FIXTURE);

    // Assert over the WHOLE event set, not a sample.
    const everything = JSON.stringify({ records, signals });
    expect(everything).not.toContain(GOVERNESS_FIXTURE_PROMPT_BODY);
    for (const signal of signals) {
      expect(JSON.stringify(signal)).not.toContain(
        GOVERNESS_FIXTURE_PROMPT_BODY
      );
    }
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain(
        GOVERNESS_FIXTURE_PROMPT_BODY
      );
      if (record.action !== "observe-runtime") {
        expect(record.payload).toBeUndefined();
      }
    }

    // The check would pass vacuously if the fixture never carried a body, so
    // prove the body was actually in play and that its hash did reach history.
    const bodyBeats = GOVERNESS_FIXTURE.filter(
      (beat) =>
        "payload" in beat && beat.payload === GOVERNESS_FIXTURE_PROMPT_BODY
    );
    expect(bodyBeats.length).toBeGreaterThan(0);
    const bodyHash = await sha256(GOVERNESS_FIXTURE_PROMPT_BODY);
    expect(records.some((record) => record.payloadHash === bodyHash)).toBe(
      true
    );

    // The signal fence is one guard; the reducer is the other. Probe the reducer
    // directly with a body attached to an effectful action, which is what a
    // careless caller or a widened signal would produce. The record must drop it.
    const probe = decideGovernessPrepare(
      emptyGovernessControlState(),
      {
        action: "nudge",
        at: "2026-09-01T00:05:00.000Z",
        epoch: 1,
        idempotencyKey: "probe:1",
        payload: GOVERNESS_FIXTURE_PROMPT_BODY,
        payloadHash: bodyHash,
        policyClass: "safe-automatic",
      },
      "00000000-0000-4000-8000-00000000ffff"
    );
    expect(probe.record.payload).toBeUndefined();
    expect(JSON.stringify(probe.record)).not.toContain(
      GOVERNESS_FIXTURE_PROMPT_BODY
    );
    expect(probe.record.payloadHash).toBe(bodyHash);
  });

  test("the beat workflow rejects a prompt body at the signal boundary", () => {
    const state = governessBeatWorkflowDefinition.start(
      { runId: RUN_ID },
      {
        at: "2026-09-01T00:00:00.000Z",
        nextRevision: 1,
        requestId: "start",
        workflowId: governessBeatWorkflowId(RUN_ID),
      }
    ).state;
    expect(() =>
      governessBeatWorkflowDefinition.signal(
        state,
        "prepare_control",
        {
          action: "nudge",
          at: "2026-09-01T00:01:00.000Z",
          controlId: "00000000-0000-4000-8000-000000000001",
          epoch: 1,
          idempotencyKey: "nudge:1",
          payload: GOVERNESS_FIXTURE_PROMPT_BODY,
          payloadHash: "deadbeef",
          policyClass: "safe-automatic",
        },
        {
          at: "2026-09-01T00:01:00.000Z",
          nextRevision: 2,
          requestId: "req-1",
          workflowId: governessBeatWorkflowId(RUN_ID),
        }
      )
    ).toThrow(/metadata only/);
  });

  test("keeps Node built-ins out of the reducer so it bundles into the workflow sandbox", async () => {
    const source = await readFile("src/loop/governess-journal-core.ts", "utf8");
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("@temporalio/");
  });
});

describe("loop governess history", () => {
  test("prints the read model for a run, hash-only for effectful controls", () => {
    const home = mkdtempSync(join(tmpdir(), "gov6-cli-"));
    const state = loadRunState("gov6-history-test", process.cwd(), home);
    mkdirSync(state.storage.runDir, { recursive: true });
    copyFileSync(GOLDEN, join(state.storage.runDir, "governess-control.jsonl"));

    // fix8: with no journal configured (no LOOP_GOVERNESS_TEMPORAL_*, no
    // orchestration config) the history names the per-host default queue.
    const pinned = {
      LOOP_GOVERNESS_TEMPORAL: undefined,
      LOOP_GOVERNESS_TEMPORAL_ADDRESS: undefined,
      LOOP_GOVERNESS_TEMPORAL_NAMESPACE: undefined,
      LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE: undefined,
      LOOP_ORCHESTRATION_CONFIG: join(home, "absent-orchestration.json"),
    } as const;
    const saved = Object.fromEntries(
      Object.keys(pinned).map((key) => [key, process.env[key]])
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    for (const [key, value] of Object.entries(pinned)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      runGovernessUtilityCommand(
        ["governess", "history", "gov6-history-test"],
        process.cwd(),
        home
      );
    } finally {
      process.stdout.write = original;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    const printed = JSON.parse(chunks.join("")) as {
      legacyWorkflowId: string;
      records: GovernessControlRecord[];
      taskQueue: string;
      workflowId: string;
      workflowType: string;
    };
    const golden = readFileSync(GOLDEN, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GovernessControlRecord);

    expect(printed.workflowType).toBe(GOVERNESS_BEAT_WORKFLOW_TYPE);
    // fix7: the repo-, run- and queue-qualified id, plus the legacy one.
    // fix8: the queue is the per-host default, `loop-governess-<host>`.
    const hostQueue = governessHostTaskQueue();
    expect(hostQueue).toMatch(/^loop-governess-[a-z0-9-]+$/);
    expect(printed.taskQueue).toBe(hostQueue);
    expect(printed.workflowId).toBe(
      `governess-beat:v2:${state.storage.repoId}:gov6-history-test:${hostQueue}`
    );
    expect(printed.legacyWorkflowId).toBe(
      governessBeatWorkflowId("gov6-history-test")
    );
    expect(printed.records).toHaveLength(golden.length);
    // Ordered by sequence, and the audit contract holds through the CLI too.
    expect(printed.records.map((record) => record.sequence)).toEqual(
      golden.map((record) => record.sequence)
    );
    expect(JSON.stringify(printed)).not.toContain(
      GOVERNESS_FIXTURE_PROMPT_BODY
    );
    for (const record of printed.records) {
      if (record.action !== "observe-runtime") {
        expect(record.payload).toBeUndefined();
      }
    }
  });
});

describe("gov-6 governess beat workflow on Temporal", () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  const taskQueue = `gov6-beat-${process.pid}`;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
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

  test("records the beat in real workflow history and exports the journal from it", async () => {
    const port = new TemporalWorkflowPort(environment.client.workflow, {
      now: () => "2026-09-01T00:00:00.000Z",
      taskQueue,
    });
    const workflowId = `${governessBeatWorkflowId(RUN_ID)}-${process.pid}`;
    await port.start({
      input: { runId: RUN_ID },
      requestId: "start",
      workflowId,
      workflowType: GOVERNESS_BEAT_WORKFLOW_TYPE,
    });

    const { signals } = await reduceFixture(GOVERNESS_FIXTURE);
    for (const [index, signal] of signals.entries()) {
      await port.signal({
        name: signal.name as string,
        payload: signal.payload as JsonObject,
        requestId: `req-${index + 1}`,
        workflowId,
      });
    }

    const queried = await port.query({ name: "journal", workflowId });
    const fromHistory = queried.value as unknown as GovernessControlRecord[];
    const golden = readFileSync(GOLDEN, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GovernessControlRecord);

    expect(fromHistory).toHaveLength(golden.length);
    expect(fromHistory.map((record) => record.sequence)).toEqual(
      golden.map((record) => record.sequence)
    );
    // Check 3 against the real thing: the whole signalled event set.
    expect(JSON.stringify(signals)).not.toContain(
      GOVERNESS_FIXTURE_PROMPT_BODY
    );
    expect(JSON.stringify(fromHistory)).not.toContain(
      GOVERNESS_FIXTURE_PROMPT_BODY
    );
  }, 180_000);
});

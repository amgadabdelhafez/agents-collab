// gov-6: the governess control journal written through the governess-beat.v1
// Temporal workflow.
//
// AUTHORITY: when LOOP_GOVERNESS_TEMPORAL_ADDRESS and
// LOOP_GOVERNESS_TEMPORAL_NAMESPACE are both set, the workflow history is the
// authoritative journal. The local JSONL file stays the synchronous write-ahead
// copy the governess fences against while it runs; on every governess start the
// file is reconciled FROM history (history wins any disagreement), and only a
// file tail newer than history, which is records the dying pane never got to
// signal, is replayed into history. With neither variable set the file journal
// is the only journal and nothing here is loaded or dialled.
//
// Writes use signalWithStart, so the history is durable even when no worker is
// polling the task queue. Reads fold the signal events out of the history
// directly, so recovery needs the server and nothing else.

import type { WorkflowClient } from "@temporalio/client";
import {
  GOVERNESS_BEAT_WORKFLOW_TYPE,
  governessBeatWorkflowId,
} from "./governess-beat-workflow";
import {
  readGovernessJournal,
  readGovernessJournalWithArchive,
  replaceGovernessJournal,
  setGovernessJournalSink,
} from "./governess-journal";
import {
  decideGovernessRecordAppend,
  type GovernessControlRecord,
  sameGovernessControlRecord,
} from "./governess-journal-core";

export const GOVERNESS_TEMPORAL_DEFAULT_TASK_QUEUE = "loop-governess";
export const GOVERNESS_APPEND_RECORD_SIGNAL = "append_record";
// Must match temporalCommandSignal in temporal-workflow.ts. Kept literal so the
// file-only path never imports the Temporal SDK.
const WORKFLOW_PORT_COMMAND_SIGNAL = "workflow-port-command";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const ADDRESS_RE = /^[a-zA-Z0-9.:[\]-]{1,255}$/;

export interface GovernessTemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;
}

/**
 * Both address and namespace, or neither. A half-configured journal is a hard
 * error rather than a silent file fallback: the operator asked for Temporal.
 */
export const governessTemporalConfigFromEnv = (
  env: NodeJS.ProcessEnv
): GovernessTemporalConfig | undefined => {
  const address = env.LOOP_GOVERNESS_TEMPORAL_ADDRESS?.trim() ?? "";
  const namespace = env.LOOP_GOVERNESS_TEMPORAL_NAMESPACE?.trim() ?? "";
  if (!(address || namespace)) {
    return undefined;
  }
  if (!(address && namespace)) {
    throw new Error(
      "governess Temporal journal needs both LOOP_GOVERNESS_TEMPORAL_ADDRESS and LOOP_GOVERNESS_TEMPORAL_NAMESPACE"
    );
  }
  const taskQueue =
    env.LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE?.trim() ||
    GOVERNESS_TEMPORAL_DEFAULT_TASK_QUEUE;
  if (!ADDRESS_RE.test(address)) {
    throw new Error("LOOP_GOVERNESS_TEMPORAL_ADDRESS is invalid");
  }
  if (!NAME_RE.test(namespace)) {
    throw new Error("LOOP_GOVERNESS_TEMPORAL_NAMESPACE is invalid");
  }
  if (!NAME_RE.test(taskQueue)) {
    throw new Error("LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE is invalid");
  }
  return { address, namespace, taskQueue };
};

/** The two operations the journal needs from Temporal. */
export interface GovernessTemporalJournalClient {
  appendRecord(runId: string, record: GovernessControlRecord): Promise<void>;
  close(): Promise<void>;
  readRecords(runId: string): Promise<GovernessControlRecord[]>;
  workflowId(runId: string): string;
}

interface HistoryPayload {
  data?: Uint8Array | null;
  metadata?: Record<string, Uint8Array> | null;
}

export interface GovernessHistoryEvent {
  workflowExecutionSignaledEventAttributes?: {
    input?: { payloads?: HistoryPayload[] | null } | null;
    signalName?: string | null;
  } | null;
}

/**
 * Fold the journal out of raw workflow history: every `append_record` command
 * signal, in history order, through the same append rule the workflow applies.
 */
export const governessJournalFromHistoryEvents = (
  events: readonly GovernessHistoryEvent[],
  decode: HistoryPayloadDecoder
): GovernessControlRecord[] => {
  const records: GovernessControlRecord[] = [];
  for (const event of events) {
    const signaled = event.workflowExecutionSignaledEventAttributes;
    if (signaled?.signalName !== WORKFLOW_PORT_COMMAND_SIGNAL) {
      continue;
    }
    const payload = signaled.input?.payloads?.[0];
    if (!payload) {
      continue;
    }
    const command = decode(payload) as {
      kind?: unknown;
      name?: unknown;
      payload?: { record?: unknown };
    };
    if (
      command?.kind !== "signal" ||
      command.name !== GOVERNESS_APPEND_RECORD_SIGNAL
    ) {
      continue;
    }
    const outcome = decideGovernessRecordAppend(
      records,
      command.payload?.record
    );
    if (outcome.kind === "appended") {
      records.push(outcome.record);
    }
  }
  return records;
};

const appendRequestId = (record: GovernessControlRecord): string =>
  `append:${record.sequence}:${record.controlId}:${record.phase}`;

const GRPC_NOT_FOUND = 5;

// A run that has never signalled has no workflow yet: an empty journal, not a
// failure. fetchHistory surfaces that as a raw gRPC NOT_FOUND.
const isWorkflowNotFound = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate?.name === "WorkflowNotFoundError" ||
    candidate?.code === GRPC_NOT_FOUND
  );
};

// Temporal buffers signals that arrive while a workflow task is in flight and
// writes them to history only when that task finishes. A read taken mid-task can
// therefore miss acknowledged records, so recovery waits for a settled history:
// no started workflow task, and the event count unchanged across the read.
const PENDING_WORKFLOW_TASK_STARTED = 2;
const HISTORY_SETTLE_MS = 60_000;
const HISTORY_SETTLE_POLL_MS = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const workflowTaskInFlight = (description: {
  raw: { pendingWorkflowTask?: { state?: unknown } | null };
}): boolean =>
  Number(description.raw.pendingWorkflowTask?.state) ===
  PENDING_WORKFLOW_TASK_STARTED;

const readSettledHistory = async (
  handle: ReturnType<WorkflowClient["getHandle"]>
): Promise<GovernessHistoryEvent[] | undefined> => {
  if (workflowTaskInFlight(await handle.describe())) {
    return undefined;
  }
  const events = ((await handle.fetchHistory()).events ??
    []) as GovernessHistoryEvent[];
  const after = await handle.describe();
  if (workflowTaskInFlight(after) || after.historyLength !== events.length) {
    return undefined;
  }
  return events;
};

type HistoryPayloadDecoder = (payload: HistoryPayload) => unknown;

/**
 * The journal client over an already-connected WorkflowClient. Split from
 * connectGovernessTemporalJournal so tests can hand in a test-server client.
 */
export const createGovernessTemporalJournalClient = (input: {
  client: WorkflowClient;
  close?: () => Promise<void>;
  decode: HistoryPayloadDecoder;
  settleTimeoutMs?: number;
  taskQueue: string;
}): GovernessTemporalJournalClient => ({
  async appendRecord(runId, record) {
    const workflowId = governessBeatWorkflowId(runId);
    await input.client.signalWithStart("temporalWorkflow", {
      args: [
        {
          at: record.at,
          input: { runId },
          requestId: `start:${runId}`,
          workflowId,
          workflowType: GOVERNESS_BEAT_WORKFLOW_TYPE,
        },
      ],
      signal: WORKFLOW_PORT_COMMAND_SIGNAL,
      signalArgs: [
        {
          at: record.at,
          kind: "signal",
          name: GOVERNESS_APPEND_RECORD_SIGNAL,
          payload: { record },
          requestId: appendRequestId(record),
        },
      ],
      taskQueue: input.taskQueue,
      workflowId,
    });
  },
  async close() {
    await input.close?.();
  },
  async readRecords(runId) {
    const handle = input.client.getHandle(governessBeatWorkflowId(runId));
    const deadline = Date.now() + (input.settleTimeoutMs ?? HISTORY_SETTLE_MS);
    for (;;) {
      let settled: GovernessHistoryEvent[] | undefined;
      try {
        settled = await readSettledHistory(handle);
      } catch (error) {
        if (isWorkflowNotFound(error)) {
          return [];
        }
        throw error;
      }
      if (settled) {
        return governessJournalFromHistoryEvents(settled, input.decode);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `governess journal history for ${runId} did not settle; a workflow task is still in flight`
        );
      }
      await sleep(HISTORY_SETTLE_POLL_MS);
    }
  },
  workflowId: governessBeatWorkflowId,
});

/**
 * Connect to the configured server. The SDK is imported here and only here, so
 * the file-only governess never loads it.
 */
export const connectGovernessTemporalJournal = async (
  config: GovernessTemporalConfig
): Promise<GovernessTemporalJournalClient> => {
  const { Connection, WorkflowClient, defaultPayloadConverter } = await import(
    "@temporalio/client"
  );
  const connection = await Connection.connect({ address: config.address });
  return createGovernessTemporalJournalClient({
    client: new WorkflowClient({ connection, namespace: config.namespace }),
    close: () => connection.close(),
    decode: (payload) =>
      defaultPayloadConverter.fromPayload(
        payload as Parameters<typeof defaultPayloadConverter.fromPayload>[0]
      ),
    taskQueue: config.taskQueue,
  });
};

/**
 * Ordered, single-flight delivery of appended records. A failed send keeps its
 * record queued and stops the drain, so records are never signalled out of
 * order; the next start's recovery replays whatever is still unsent.
 */
export class GovernessTemporalJournalSink {
  readonly #client: GovernessTemporalJournalClient;
  readonly #onError: (error: unknown, record: GovernessControlRecord) => void;
  readonly #queue: GovernessControlRecord[] = [];
  readonly #runId: string;
  #draining: Promise<void> | undefined;
  #failed = false;

  constructor(
    client: GovernessTemporalJournalClient,
    runId: string,
    onError: (error: unknown, record: GovernessControlRecord) => void = () =>
      undefined
  ) {
    this.#client = client;
    this.#runId = runId;
    this.#onError = onError;
  }

  get pending(): number {
    return this.#queue.length;
  }

  enqueue(record: GovernessControlRecord): void {
    this.#queue.push(record);
    this.#failed = false;
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = undefined;
    });
  }

  /** Resolves once the queue is empty or a send has failed. */
  async flush(): Promise<void> {
    while (this.#draining) {
      await this.#draining;
    }
    if (this.#queue.length > 0 && !this.#failed) {
      this.#draining = this.#drain().finally(() => {
        this.#draining = undefined;
      });
      await this.#draining;
    }
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const record = this.#queue[0] as GovernessControlRecord;
      try {
        await this.#client.appendRecord(this.#runId, record);
      } catch (error) {
        this.#failed = true;
        this.#onError(error, record);
        return;
      }
      this.#queue.shift();
    }
  }
}

export interface GovernessJournalRecovery {
  backfilled: number;
  divergedAt?: number;
  fileRecords: number;
  // False when history still ends short of the local journal after backfill,
  // for example because an archived record was deleted. Logged, not fatal.
  historyComplete: boolean;
  rewroteFile: boolean;
  temporalRecords: number;
}

/**
 * Reconcile the local journal with the authoritative history before the
 * governess issues any control.
 *
 * - Same sequence, different record: history wins, the file is rewritten from
 *   history and its newer tail is dropped (it was decided on a diverged log).
 * - The local journal (active file plus compaction archive) holds records
 *   newer than history: they are signalled in order, then history is read
 *   again to confirm it reaches the local last sequence (`historyComplete`).
 * - History holds records the file lacks past the file's last sequence (the
 *   file was lost or truncated with the pane): the file is rewritten.
 * Sequences below the file's last one that only history holds are records
 * compaction archived from the file, and are left alone.
 */
export const recoverGovernessJournalFromTemporal = async (
  journalFile: string,
  runId: string,
  client: GovernessTemporalJournalClient
): Promise<GovernessJournalRecovery> => {
  const fromHistory = await client.readRecords(runId);
  const fromFile = readGovernessJournal(journalFile);
  // Compaction may have archived records history never received, so the local
  // side of the comparison is the active file plus its archive.
  const local = readGovernessJournalWithArchive(journalFile);
  const bySequence = new Map(
    fromHistory.map((record) => [record.sequence, record])
  );
  const historyLast = fromHistory.at(-1)?.sequence ?? 0;
  const fileLast = fromFile.at(-1)?.sequence ?? 0;
  const diverged = local.find((record) => {
    const held = bySequence.get(record.sequence);
    return held !== undefined && !sameGovernessControlRecord(held, record);
  });
  if (diverged) {
    replaceGovernessJournal(journalFile, fromHistory);
    return {
      backfilled: 0,
      divergedAt: diverged.sequence,
      fileRecords: fromFile.length,
      historyComplete: true,
      rewroteFile: true,
      temporalRecords: fromHistory.length,
    };
  }
  const tail = local.filter((record) => record.sequence > historyLast);
  for (const record of tail) {
    await client.appendRecord(runId, record);
  }
  const rewroteFile = historyLast > fileLast;
  if (rewroteFile) {
    replaceGovernessJournal(journalFile, fromHistory);
  }
  // A tail with a sequence hole is rejected from the hole onward, so confirm
  // history now reaches the local last sequence instead of assuming it.
  const temporalRecords =
    tail.length > 0
      ? (await client.readRecords(runId)).length
      : fromHistory.length;
  const localLast = Math.max(historyLast, local.at(-1)?.sequence ?? 0);
  return {
    backfilled: tail.length,
    fileRecords: fromFile.length,
    historyComplete: temporalRecords === localLast,
    rewroteFile,
    temporalRecords,
  };
};

export type GovernessJournalBackend =
  | { close(): Promise<void>; kind: "file" }
  | {
      close(): Promise<void>;
      kind: "temporal";
      recovery: GovernessJournalRecovery;
      sink: GovernessTemporalJournalSink;
      workflowId: string;
    };

/**
 * Choose and arm the journal backend for one governess run. With no Temporal
 * config this returns the file backend without calling `connect`.
 */
export const attachGovernessJournalBackend = async (input: {
  connect?: (
    config: GovernessTemporalConfig
  ) => Promise<GovernessTemporalJournalClient>;
  journalFile: string;
  onSinkError?: (error: unknown, record: GovernessControlRecord) => void;
  runId: string;
  temporal?: GovernessTemporalConfig;
}): Promise<GovernessJournalBackend> => {
  if (!input.temporal) {
    return { close: async () => undefined, kind: "file" };
  }
  const connect = input.connect ?? connectGovernessTemporalJournal;
  const client = await connect(input.temporal);
  try {
    const recovery = await recoverGovernessJournalFromTemporal(
      input.journalFile,
      input.runId,
      client
    );
    const sink = new GovernessTemporalJournalSink(
      client,
      input.runId,
      input.onSinkError
    );
    setGovernessJournalSink(input.journalFile, (record) =>
      sink.enqueue(record)
    );
    return {
      async close() {
        setGovernessJournalSink(input.journalFile, undefined);
        await sink.flush();
        await client.close();
      },
      kind: "temporal",
      recovery,
      sink,
      workflowId: client.workflowId(input.runId),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

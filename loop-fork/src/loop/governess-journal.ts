// gov-6: this module is the JSONL read/write face of the governess control log.
// The decision logic it used to own now lives in ./governess-journal-core, which
// the governess-beat.v1 workflow reduces over Temporal history. Both paths share
// one reducer so the exported history read model and this JSONL journal cannot
// drift apart.

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GovernessControlPhase as CoreGovernessControlPhase,
  GovernessControlRecord as CoreGovernessControlRecord,
  GovernessControlTransitionDetails as CoreGovernessControlTransitionDetails,
  GovernessControlTransport as CoreGovernessControlTransport,
} from "./governess-journal-core";
import {
  applyGovernessControlRecord,
  GOVERNESS_OBSERVATION_HEARTBEAT_MS as CORE_GOVERNESS_OBSERVATION_HEARTBEAT_MS,
  decideGovernessObservation,
  decideGovernessPrepare,
  decideGovernessTransition,
  emptyGovernessControlState,
  type GovernessControlState,
  isGovernessControlRecord,
} from "./governess-journal-core";
import type {
  GovernessAction,
  GovernessActionClass,
  GovernessPolicyContext,
} from "./governess-policy";
import type { Agent, HookEvent } from "./types";

// The record contract now lives in ./governess-journal-core so the workflow
// reducer and this JSONL writer cannot drift. Aliased rather than re-exported
// to keep existing importers of this module working.
export type GovernessControlPhase = CoreGovernessControlPhase;
export type GovernessControlRecord = CoreGovernessControlRecord;
export type GovernessControlTransitionDetails =
  CoreGovernessControlTransitionDetails;
export type GovernessControlTransport = CoreGovernessControlTransport;
export const GOVERNESS_OBSERVATION_HEARTBEAT_MS =
  CORE_GOVERNESS_OBSERVATION_HEARTBEAT_MS;

interface GovernessJournalIndex extends GovernessControlState {
  sourceBytes: number;
  sourceMtimeMs: number;
  version: 1;
}

export interface GovernessJournalCompaction {
  activeRecords: number;
  archivedRecords: number;
  archiveFile?: string;
}

export interface GovernessJournalStorageStatus {
  activeBytes: number;
  activeRecords: number;
  indexCurrent: boolean;
  indexFile: string;
  observationRecords: number;
  pendingControls: number;
}

export const GOVERNESS_JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;
const JOURNAL_INDEX_SUFFIX = ".index.json";
const JOURNAL_ARCHIVE_SUFFIX = ".archive";
const indexCache = new Map<string, GovernessJournalIndex>();

const isControlRecord = isGovernessControlRecord;

// Hashing lives on this side of the boundary: the pure reducer must stay free of
// Node built-ins so it can bundle into the Temporal workflow sandbox.
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const ensureGovernessJournal = (journalFile: string): void => {
  mkdirSync(dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, "", "utf8");
};

export const readGovernessJournal = (
  journalFile: string
): GovernessControlRecord[] => {
  let raw: string;
  try {
    raw = readFileSync(journalFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(
          `malformed governess journal JSON at line ${index + 1}`
        );
      }
      if (!isControlRecord(value)) {
        throw new Error(
          `invalid governess journal record at line ${index + 1}`
        );
      }
      return value;
    });
};

const journalIndexPath = (journalFile: string): string =>
  `${journalFile}${JOURNAL_INDEX_SUFFIX}`;

const journalStat = (
  journalFile: string
): { sourceBytes: number; sourceMtimeMs: number } => {
  const stat = statSync(journalFile);
  return { sourceBytes: stat.size, sourceMtimeMs: stat.mtimeMs };
};

const emptyJournalIndex = (): GovernessJournalIndex => ({
  ...emptyGovernessControlState(),
  sourceBytes: 0,
  sourceMtimeMs: 0,
  version: 1,
});

const applyRecordToIndex = (
  index: GovernessJournalIndex,
  record: GovernessControlRecord
): void => {
  applyGovernessControlRecord(index, record);
};

const buildJournalIndex = (
  journalFile: string,
  records: GovernessControlRecord[]
): GovernessJournalIndex => {
  const index = emptyJournalIndex();
  for (const record of records) {
    applyRecordToIndex(index, record);
  }
  Object.assign(index, journalStat(journalFile));
  return index;
};

const isJournalIndex = (value: unknown): value is GovernessJournalIndex => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const index = value as Partial<GovernessJournalIndex>;
  const controlMap = (candidate: unknown): boolean =>
    Boolean(candidate) &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.values(candidate as Record<string, unknown>).every(isControlRecord);
  const pendingMap = (candidate: unknown): boolean =>
    Boolean(candidate) &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.values(candidate as Record<string, unknown>).every(
      (history) =>
        Array.isArray(history) &&
        history.every((record) => isControlRecord(record))
    );
  const dispatchedMap = (candidate: unknown): boolean =>
    Boolean(candidate) &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.values(candidate as Record<string, unknown>).every(
      (dispatched) => dispatched === true
    );
  return (
    index.version === 1 &&
    typeof index.sequence === "number" &&
    typeof index.sourceBytes === "number" &&
    typeof index.sourceMtimeMs === "number" &&
    dispatchedMap(index.dispatchedControls) &&
    controlMap(index.latestByControl) &&
    controlMap(index.latestByIdempotency) &&
    controlMap(index.latestObservationByStream) &&
    pendingMap(index.pendingHistoryByControl)
  );
};

const persistJournalIndex = (
  journalFile: string,
  index: GovernessJournalIndex
): void => {
  const path = journalIndexPath(journalFile);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(index), "utf8");
  renameSync(temporary, path);
  indexCache.set(journalFile, index);
};

const loadJournalIndex = (journalFile: string): GovernessJournalIndex => {
  ensureGovernessJournal(journalFile);
  const source = journalStat(journalFile);
  const cached = indexCache.get(journalFile);
  if (
    cached?.sourceBytes === source.sourceBytes &&
    cached.sourceMtimeMs === source.sourceMtimeMs
  ) {
    return cached;
  }
  const path = journalIndexPath(journalFile);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      isJournalIndex(parsed) &&
      parsed.sourceBytes === source.sourceBytes &&
      parsed.sourceMtimeMs === source.sourceMtimeMs
    ) {
      indexCache.set(journalFile, parsed);
      return parsed;
    }
  } catch {
    // Missing, stale, and corrupt indexes rebuild from authoritative JSONL.
  }
  const rebuilt = buildJournalIndex(
    journalFile,
    readGovernessJournal(journalFile)
  );
  persistJournalIndex(journalFile, rebuilt);
  return rebuilt;
};

export const ensureGovernessJournalIndex = (journalFile: string): void => {
  loadJournalIndex(journalFile);
};

// gov-6: a journal file may have a write-through sink (the Temporal beat
// workflow). The file append stays synchronous and first so every decision
// keeps its local idempotency fence; the sink receives the same record after.
const journalSinks = new Map<
  string,
  (record: GovernessControlRecord) => void
>();

export const setGovernessJournalSink = (
  journalFile: string,
  sink: ((record: GovernessControlRecord) => void) | undefined
): void => {
  if (sink) {
    journalSinks.set(journalFile, sink);
  } else {
    journalSinks.delete(journalFile);
  }
};

const append = (
  journalFile: string,
  record: GovernessControlRecord,
  index: GovernessJournalIndex
): void => {
  ensureGovernessJournal(journalFile);
  appendFileSync(journalFile, `${JSON.stringify(record)}\n`, "utf8");
  applyRecordToIndex(index, record);
  Object.assign(index, journalStat(journalFile));
  persistJournalIndex(journalFile, index);
  journalSinks.get(journalFile)?.(record);
};

/**
 * Every record the local journal still holds, active file plus the records
 * compaction moved into `<journal>.archive/`, one per sequence, in order.
 */
export const readGovernessJournalWithArchive = (
  journalFile: string
): GovernessControlRecord[] => {
  const archiveDir = `${journalFile}${JOURNAL_ARCHIVE_SUFFIX}`;
  let archiveFiles: string[] = [];
  try {
    archiveFiles = readdirSync(archiveDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(archiveDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const bySequence = new Map<number, GovernessControlRecord>();
  for (const file of [...archiveFiles, journalFile]) {
    for (const record of readGovernessJournal(file)) {
      bySequence.set(record.sequence, record);
    }
  }
  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence
  );
};

/**
 * Replace the local journal with an authoritative record log (gov-6 recovery
 * from Temporal history). Atomic rename, then the index is rebuilt from the new
 * bytes so the next decision fences against the recovered log.
 */
export const replaceGovernessJournal = (
  journalFile: string,
  records: readonly GovernessControlRecord[]
): void => {
  ensureGovernessJournal(journalFile);
  const temporary = `${journalFile}.${process.pid}.recover`;
  writeFileSync(temporary, serializeGovernessJournal(records), "utf8");
  renameSync(temporary, journalFile);
  indexCache.delete(journalFile);
  ensureGovernessJournalIndex(journalFile);
};

export const prepareGovernessControl = (
  journalFile: string,
  input: {
    action: GovernessAction;
    agent?: Agent;
    at: string;
    epoch: number;
    idempotencyKey: string;
    payload: string;
    policyClass: GovernessActionClass;
    policyContext?: GovernessPolicyContext;
  }
): GovernessControlRecord => {
  const index = loadJournalIndex(journalFile);
  const decision = decideGovernessPrepare(
    index,
    {
      ...input,
      payloadHash: hash(input.payload),
      ...(input.action === "observe-runtime" ? { payload: input.payload } : {}),
    },
    randomUUID()
  );
  if (decision.appended) {
    append(journalFile, decision.record, index);
  }
  return decision.record;
};

export const recordGovernessObservation = (
  journalFile: string,
  input: {
    agent?: Agent;
    at: string;
    epoch: number;
    heartbeatMs?: number;
    idempotencyKey: string;
    payload: string;
    policyClass: GovernessActionClass;
    policyContext?: GovernessPolicyContext;
    semanticPayload?: string;
    stream: string;
  }
): { record: GovernessControlRecord; written: boolean } => {
  const index = loadJournalIndex(journalFile);
  const decision = decideGovernessObservation(
    index,
    {
      ...input,
      payloadHash: hash(input.payload),
      semanticHash: hash(input.semanticPayload ?? input.payload),
    },
    randomUUID()
  );
  if (decision.appended) {
    append(journalFile, decision.record, index);
  }
  return { record: decision.record, written: decision.appended };
};

export const transitionGovernessControl = (
  journalFile: string,
  controlId: string,
  phase: GovernessControlPhase,
  at: string,
  reason?: string,
  details: GovernessControlTransitionDetails = {}
): GovernessControlRecord | undefined => {
  const index = loadJournalIndex(journalFile);
  const decision = decideGovernessTransition(
    index,
    controlId,
    phase,
    at,
    reason,
    details
  );
  if (!decision) {
    return undefined;
  }
  if (decision.appended) {
    append(journalFile, decision.record, index);
  }
  return decision.record;
};

const latestRecordsByControl = (
  records: GovernessControlRecord[]
): GovernessControlRecord[] => {
  const latest = new Map<string, GovernessControlRecord>();
  for (const record of records) {
    latest.set(record.controlId, record);
  }
  return [...latest.values()];
};

export const pendingGovernessControlHistory = (
  records: GovernessControlRecord[]
): GovernessControlRecord[] => {
  const pendingIds = new Set(
    latestRecordsByControl(records)
      .filter(
        (record) => record.phase !== "completed" && record.phase !== "failed"
      )
      .map((record) => record.controlId)
  );
  return records.filter((record) => pendingIds.has(record.controlId));
};

export const readPendingGovernessControlHistory = (
  journalFile: string
): GovernessControlRecord[] =>
  Object.values(loadJournalIndex(journalFile).pendingHistoryByControl)
    .flat()
    .sort((left, right) => left.sequence - right.sequence);

export const latestGovernessControlByKey = (
  journalFile: string,
  idempotencyKey: string
): GovernessControlRecord | undefined =>
  loadJournalIndex(journalFile).latestByIdempotency[idempotencyKey];

const observationStreamForCompaction = (
  record: GovernessControlRecord
): string => record.observationStream ?? `legacy:${record.agent ?? "loop"}`;

export const compactGovernessJournal = (
  journalFile: string,
  at = new Date().toISOString()
): GovernessJournalCompaction => {
  const records = readGovernessJournal(journalFile);
  const latestObservation = new Map<string, GovernessControlRecord>();
  for (const record of records) {
    if (record.action === "observe-runtime" && record.phase === "completed") {
      latestObservation.set(observationStreamForCompaction(record), record);
    }
  }
  const retainedObservationIds = new Set(
    [...latestObservation.values()].map((record) => record.controlId)
  );
  const active = records.filter(
    (record) =>
      record.action !== "observe-runtime" ||
      retainedObservationIds.has(record.controlId)
  );
  const archived = records.filter((record) => !active.includes(record));
  if (archived.length === 0) {
    ensureGovernessJournalIndex(journalFile);
    return { activeRecords: active.length, archivedRecords: 0 };
  }

  const archiveDir = `${journalFile}${JOURNAL_ARCHIVE_SUFFIX}`;
  mkdirSync(archiveDir, { recursive: true });
  const stamp = at.replace(/[^0-9A-Za-z]/g, "-");
  const first = archived[0]?.sequence ?? 0;
  const last = archived.at(-1)?.sequence ?? first;
  const archiveFile = join(archiveDir, `${stamp}-${first}-${last}.jsonl`);
  const archiveTemp = `${archiveFile}.${process.pid}.tmp`;
  writeFileSync(
    archiveTemp,
    `${archived.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
  renameSync(archiveTemp, archiveFile);

  const activeTemp = `${journalFile}.${process.pid}.compact`;
  writeFileSync(
    activeTemp,
    active.length > 0
      ? `${active.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "",
    "utf8"
  );
  renameSync(activeTemp, journalFile);
  indexCache.delete(journalFile);
  ensureGovernessJournalIndex(journalFile);
  return {
    activeRecords: active.length,
    archiveFile,
    archivedRecords: archived.length,
  };
};

export const maintainGovernessJournal = (
  journalFile: string
): GovernessJournalCompaction | undefined => {
  ensureGovernessJournal(journalFile);
  if (statSync(journalFile).size < GOVERNESS_JOURNAL_COMPACT_BYTES) {
    ensureGovernessJournalIndex(journalFile);
    return undefined;
  }
  return compactGovernessJournal(journalFile);
};

export const inspectGovernessJournalStorage = (
  journalFile: string
): GovernessJournalStorageStatus => {
  ensureGovernessJournal(journalFile);
  const records = readGovernessJournal(journalFile);
  const index = loadJournalIndex(journalFile);
  const source = journalStat(journalFile);
  return {
    activeBytes: source.sourceBytes,
    activeRecords: records.length,
    indexCurrent:
      index.sourceBytes === source.sourceBytes &&
      index.sourceMtimeMs === source.sourceMtimeMs,
    indexFile: journalIndexPath(journalFile),
    observationRecords: records.filter(
      (record) => record.action === "observe-runtime"
    ).length,
    pendingControls: Object.keys(index.pendingHistoryByControl).length,
  };
};

const dispatchedAt = (
  records: GovernessControlRecord[],
  controlId: string
): number | undefined => {
  const record = records.find(
    (candidate) =>
      candidate.controlId === controlId && candidate.phase === "dispatched"
  );
  if (!record) {
    return undefined;
  }
  const parsed = Date.parse(record.at);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const governessHookEventReference = (event: HookEvent): string =>
  `${event.agent}:${event.event}:${event.sequence ?? event.ts}:${event.ts}`;

export interface GovernessControlReconciliation {
  at: string;
  controlId: string;
  evidence: string;
  phase: "acknowledged" | "completed" | "failed";
}

export const GOVERNESS_CONTROL_CONSUMPTION_TIMEOUT_MS = 120_000;

// Pure reconciliation: provider-authored hook evidence after dispatch is the
// acknowledgement. A Stop event is terminal evidence. We deliberately do not
// turn elapsed time into a resend decision; an ambiguous dispatched control is
// safer left pending than duplicated into a shared composer.
export const decideGovernessControlReconciliation = (
  records: GovernessControlRecord[],
  hooksByAgent: Partial<Record<Agent, HookEvent[]>>,
  nowIso?: string
): GovernessControlReconciliation[] => {
  const decisions: GovernessControlReconciliation[] = [];
  const usedEvidence = new Set<string>();
  const pending = latestRecordsByControl(records)
    .map((record) => ({
      record,
      sentAt: dispatchedAt(records, record.controlId),
    }))
    .sort((left, right) => (left.sentAt ?? 0) - (right.sentAt ?? 0));
  for (const { record, sentAt } of pending) {
    if (
      !record.agent ||
      record.action === "observe-runtime" ||
      record.phase === "prepared" ||
      record.phase === "completed" ||
      record.phase === "failed"
    ) {
      continue;
    }
    if (sentAt === undefined) {
      continue;
    }
    const events = (hooksByAgent[record.agent] ?? []).filter(
      (event) =>
        Date.parse(event.ts) > sentAt &&
        !usedEvidence.has(governessHookEventReference(event))
    );
    const completed = events.find((event) => event.event === "Stop");
    if (completed) {
      usedEvidence.add(governessHookEventReference(completed));
      decisions.push({
        at: completed.ts,
        controlId: record.controlId,
        evidence: governessHookEventReference(completed),
        phase: "completed",
      });
      continue;
    }
    const acknowledged = events.find(
      (event) =>
        event.event === "UserPromptSubmit" ||
        event.event === "PreToolUse" ||
        event.event === "PostToolUse"
    );
    if (acknowledged && record.phase !== "acknowledged") {
      usedEvidence.add(governessHookEventReference(acknowledged));
      decisions.push({
        at: acknowledged.ts,
        controlId: record.controlId,
        evidence: governessHookEventReference(acknowledged),
        phase: "acknowledged",
      });
      continue;
    }
    const now = nowIso ? Date.parse(nowIso) : Number.NaN;
    if (
      record.phase === "accepted" &&
      Number.isFinite(now) &&
      now - sentAt >= GOVERNESS_CONTROL_CONSUMPTION_TIMEOUT_MS
    ) {
      decisions.push({
        at: nowIso ?? record.at,
        controlId: record.controlId,
        evidence: `consumption-timeout:${record.agent}:${record.controlId}`,
        phase: "failed",
      });
    }
  }
  return decisions;
};

export const applyGovernessControlReconciliation = (
  journalFile: string,
  decisions: GovernessControlReconciliation[]
): void => {
  for (const decision of decisions) {
    transitionGovernessControl(
      journalFile,
      decision.controlId,
      decision.phase,
      decision.at,
      undefined,
      { evidence: decision.evidence }
    );
  }
};

// gov-6 read model: the journal projected out of Temporal workflow history.
//
// `records` is the ordered decision log held in governess-beat.v1 state. The
// projection is deliberately trivial — the reducer already produced these
// records — because that is what makes history and the legacy JSONL file agree
// by construction rather than by a second implementation.

export const governessJournalFromHistory = (
  records: readonly GovernessControlRecord[]
): GovernessControlRecord[] =>
  [...records].sort((left, right) => left.sequence - right.sequence);

/**
 * Serialize the read model in the exact on-disk JSONL form the legacy writer
 * produces, so equality can be compared by content instead of by line count.
 */
export const serializeGovernessJournal = (
  records: readonly GovernessControlRecord[]
): string => records.map((record) => `${JSON.stringify(record)}\n`).join("");

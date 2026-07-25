import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GovernessAction,
  GovernessActionClass,
  GovernessPolicyContext,
} from "./governess-policy";
import type { Agent, HookEvent } from "./types";

export type GovernessControlPhase =
  | "prepared"
  | "dispatched"
  | "accepted"
  | "acknowledged"
  | "completed"
  | "failed";

export interface GovernessControlRecord {
  action: GovernessAction;
  agent?: Agent;
  at: string;
  controlId: string;
  epoch: number;
  evidence?: string;
  idempotencyKey: string;
  observationStream?: string;
  // Observation results are retained so replay can reconstruct decisions.
  // Effectful control messages remain hash-only to avoid duplicating prompts.
  payload?: string;
  payloadHash: string;
  phase: GovernessControlPhase;
  policyClass: GovernessActionClass;
  policyContext?: GovernessPolicyContext;
  reason?: string;
  semanticHash?: string;
  sequence: number;
  transport?: GovernessControlTransport;
}

interface GovernessJournalIndex {
  dispatchedControls: Record<string, true>;
  latestByControl: Record<string, GovernessControlRecord>;
  latestByIdempotency: Record<string, GovernessControlRecord>;
  latestObservationByStream: Record<string, GovernessControlRecord>;
  pendingHistoryByControl: Record<string, GovernessControlRecord[]>;
  sequence: number;
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

export type GovernessControlTransport =
  | "claude-channel"
  | "codex-app-server"
  | "bridge"
  | "tmux-fallback"
  | "internal";

export interface GovernessControlTransitionDetails {
  evidence?: string;
  transport?: GovernessControlTransport;
}

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const GOVERNESS_OBSERVATION_HEARTBEAT_MS = 60_000;
export const GOVERNESS_JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;
const JOURNAL_INDEX_SUFFIX = ".index.json";
const JOURNAL_ARCHIVE_SUFFIX = ".archive";
const indexCache = new Map<string, GovernessJournalIndex>();

const CONTROL_PHASES = new Set<GovernessControlPhase>([
  "prepared",
  "dispatched",
  "accepted",
  "acknowledged",
  "completed",
  "failed",
]);

const PHASE_ORDER: Record<GovernessControlPhase, number> = {
  prepared: 0,
  dispatched: 1,
  accepted: 2,
  acknowledged: 3,
  completed: 4,
  failed: 5,
};

const transitionAllowed = (
  from: GovernessControlPhase,
  to: GovernessControlPhase
): boolean => {
  if (from === to) {
    return true;
  }
  if (from === "completed" || from === "failed") {
    return false;
  }
  if (to === "failed") {
    return true;
  }
  return PHASE_ORDER[to] > PHASE_ORDER[from];
};

const isControlRecord = (value: unknown): value is GovernessControlRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<GovernessControlRecord>;
  return (
    typeof record.action === "string" &&
    typeof record.at === "string" &&
    typeof record.controlId === "string" &&
    typeof record.epoch === "number" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.payloadHash === "string" &&
    typeof record.phase === "string" &&
    CONTROL_PHASES.has(record.phase as GovernessControlPhase) &&
    typeof record.policyClass === "string" &&
    typeof record.sequence === "number" &&
    Number.isInteger(record.sequence) &&
    record.sequence > 0
  );
};

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
  dispatchedControls: {},
  latestByControl: {},
  latestByIdempotency: {},
  latestObservationByStream: {},
  pendingHistoryByControl: {},
  sequence: 0,
  sourceBytes: 0,
  sourceMtimeMs: 0,
  version: 1,
});

const applyRecordToIndex = (
  index: GovernessJournalIndex,
  record: GovernessControlRecord
): void => {
  index.sequence = Math.max(index.sequence, record.sequence);
  if (record.action === "observe-runtime") {
    if (record.observationStream) {
      index.latestObservationByStream[record.observationStream] = record;
    }
    return;
  }
  index.latestByControl[record.controlId] = record;
  index.latestByIdempotency[record.idempotencyKey] = record;
  if (record.phase === "dispatched") {
    index.dispatchedControls[record.controlId] = true;
  }
  const history = index.pendingHistoryByControl[record.controlId] ?? [];
  history.push(record);
  if (record.phase === "completed" || record.phase === "failed") {
    delete index.pendingHistoryByControl[record.controlId];
  } else {
    index.pendingHistoryByControl[record.controlId] = history;
  }
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
  const existing = index.latestByIdempotency[input.idempotencyKey];
  if (existing) {
    const dispatched = index.dispatchedControls[existing.controlId] === true;
    // A pre-dispatch failure is safe to retry with a new control id. Once an
    // effect may have crossed the transport boundary, failure is ambiguous and
    // the idempotency fence must remain closed.
    if (existing.phase !== "failed" || dispatched) {
      return existing;
    }
  }
  const record: GovernessControlRecord = {
    action: input.action,
    ...(input.agent ? { agent: input.agent } : {}),
    at: input.at,
    controlId: randomUUID(),
    epoch: input.epoch,
    idempotencyKey: input.idempotencyKey,
    payloadHash: hash(input.payload),
    ...(input.action === "observe-runtime" ? { payload: input.payload } : {}),
    phase: "prepared",
    policyClass: input.policyClass,
    ...(input.policyContext ? { policyContext: input.policyContext } : {}),
    sequence: index.sequence + 1,
  };
  append(journalFile, record, index);
  return record;
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
  const semanticHash = hash(input.semanticPayload ?? input.payload);
  const previous = index.latestObservationByStream[input.stream];
  const elapsedMs = previous
    ? Math.max(0, Date.parse(input.at) - Date.parse(previous.at))
    : Number.POSITIVE_INFINITY;
  if (
    previous?.semanticHash === semanticHash &&
    elapsedMs < (input.heartbeatMs ?? GOVERNESS_OBSERVATION_HEARTBEAT_MS)
  ) {
    return { record: previous, written: false };
  }
  const record: GovernessControlRecord = {
    action: "observe-runtime",
    ...(input.agent ? { agent: input.agent } : {}),
    at: input.at,
    controlId: randomUUID(),
    epoch: input.epoch,
    idempotencyKey: input.idempotencyKey,
    observationStream: input.stream,
    payload: input.payload,
    payloadHash: hash(input.payload),
    phase: "completed",
    policyClass: input.policyClass,
    ...(input.policyContext ? { policyContext: input.policyContext } : {}),
    semanticHash,
    sequence: index.sequence + 1,
  };
  append(journalFile, record, index);
  return { record, written: true };
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
  const previous = index.latestByControl[controlId];
  if (!previous) {
    return undefined;
  }
  if (previous.phase === phase) {
    return previous;
  }
  if (!transitionAllowed(previous.phase, phase)) {
    throw new Error(
      `invalid governess control transition ${previous.phase} -> ${phase}`
    );
  }
  const next: GovernessControlRecord = {
    ...previous,
    at,
    phase,
    ...(details.evidence ? { evidence: details.evidence } : {}),
    ...(details.transport ? { transport: details.transport } : {}),
    ...(reason ? { reason } : {}),
    sequence: index.sequence + 1,
  };
  append(journalFile, next, index);
  return next;
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
  phase: "acknowledged" | "completed";
}

// Pure reconciliation: provider-authored hook evidence after dispatch is the
// acknowledgement. A Stop event is terminal evidence. We deliberately do not
// turn elapsed time into a resend decision; an ambiguous dispatched control is
// safer left pending than duplicated into a shared composer.
export const decideGovernessControlReconciliation = (
  records: GovernessControlRecord[],
  hooksByAgent: Partial<Record<Agent, HookEvent[]>>
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

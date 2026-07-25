import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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
  // Observation results are retained so replay can reconstruct decisions.
  // Effectful control messages remain hash-only to avoid duplicating prompts.
  payload?: string;
  payloadHash: string;
  phase: GovernessControlPhase;
  policyClass: GovernessActionClass;
  policyContext?: GovernessPolicyContext;
  reason?: string;
  sequence: number;
  transport?: GovernessControlTransport;
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

const append = (journalFile: string, record: GovernessControlRecord): void => {
  ensureGovernessJournal(journalFile);
  appendFileSync(journalFile, `${JSON.stringify(record)}\n`, "utf8");
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
  const records = readGovernessJournal(journalFile);
  const existing = records
    .filter((record) => record.idempotencyKey === input.idempotencyKey)
    .at(-1);
  if (existing) {
    const dispatched = records.some(
      (record) =>
        record.controlId === existing.controlId && record.phase === "dispatched"
    );
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
    sequence: (records.at(-1)?.sequence ?? 0) + 1,
  };
  append(journalFile, record);
  return record;
};

export const transitionGovernessControl = (
  journalFile: string,
  controlId: string,
  phase: GovernessControlPhase,
  at: string,
  reason?: string,
  details: GovernessControlTransitionDetails = {}
): GovernessControlRecord | undefined => {
  const records = readGovernessJournal(journalFile);
  const previous = records
    .filter((record) => record.controlId === controlId)
    .at(-1);
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
    sequence: (records.at(-1)?.sequence ?? 0) + 1,
  };
  append(journalFile, next);
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

export const latestGovernessControlByKey = (
  journalFile: string,
  idempotencyKey: string
): GovernessControlRecord | undefined =>
  readGovernessJournal(journalFile)
    .filter((record) => record.idempotencyKey === idempotencyKey)
    .at(-1);

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

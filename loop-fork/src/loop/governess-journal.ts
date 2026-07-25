import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GovernessAction, GovernessActionClass } from "./governess-policy";
import type { Agent } from "./types";

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
  idempotencyKey: string;
  payloadHash: string;
  // Observation results are retained so replay can reconstruct decisions.
  // Effectful control messages remain hash-only to avoid duplicating prompts.
  payload?: string;
  phase: GovernessControlPhase;
  policyClass: GovernessActionClass;
  reason?: string;
  sequence: number;
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
        throw new Error(`malformed governess journal JSON at line ${index + 1}`);
      }
      if (!isControlRecord(value)) {
        throw new Error(`invalid governess journal record at line ${index + 1}`);
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
  }
): GovernessControlRecord => {
  const records = readGovernessJournal(journalFile);
  const existing = records
    .filter((record) => record.idempotencyKey === input.idempotencyKey)
    .at(-1);
  if (existing && existing.phase !== "failed") {
    return existing;
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
  reason?: string
): GovernessControlRecord | undefined => {
  const records = readGovernessJournal(journalFile);
  const previous = records.filter((record) => record.controlId === controlId).at(-1);
  if (!previous) {
    return undefined;
  }
  const next: GovernessControlRecord = {
    ...previous,
    at,
    phase,
    ...(reason ? { reason } : {}),
    sequence: (records.at(-1)?.sequence ?? 0) + 1,
  };
  append(journalFile, next);
  return next;
};

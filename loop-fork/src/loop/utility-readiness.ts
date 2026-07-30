import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  UTILITY_AU_PAIR_TIER,
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
  type UtilityExecutionTierId,
} from "./utility-execution-tier";

const DISPATCHER_LEASE_MS = 45_000;
const INFERENCE_LEASE_MS = 5 * 60_000;
const INFERENCE_FAILURE_COOLDOWN_MS = 60_000;
const MAX_LEDGER_TAIL_BYTES = 128 * 1024;

export type UtilityReadinessReason =
  | "ready"
  | "dispatcher-missing"
  | "dispatcher-malformed"
  | "dispatcher-epoch-mismatch"
  | "dispatcher-stale"
  | "inference-unknown"
  | "inference-stale"
  | "inference-failed";

export interface UtilityDispatchReadiness {
  evidenceAt?: string;
  ready: boolean;
  reason: UtilityReadinessReason;
}

interface InferenceEvidence {
  at: number;
  atIso: string;
  failed: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const readBoundedTail = (path: string): string => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_LEDGER_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start === 0) {
      return text;
    }
    const firstNewline = text.indexOf("\n");
    return firstNewline < 0 ? "" : text.slice(firstNewline + 1);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
};

const inferenceEvidence = (
  runDir: string,
  tierId: UtilityExecutionTierId
): InferenceEvidence | undefined => {
  if (tierId === UTILITY_DIRECT_TIER) {
    return undefined;
  }
  let latest: InferenceEvidence | undefined;
  const lines = readBoundedTail(join(runDir, "utility", "usage.jsonl"))
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    try {
      const record = asRecord(JSON.parse(line));
      if (record?.tierId !== tierId || typeof record.at !== "string") {
        continue;
      }
      const at = Date.parse(record.at);
      if (!(Number.isFinite(at) && (!latest || at >= latest.at))) {
        continue;
      }
      const failed = record.status === "failed";
      const modelCalls = Number(record.modelCalls ?? 0);
      if (!(failed || modelCalls > 0)) {
        continue;
      }
      latest = {
        at,
        atIso: record.at,
        failed,
      };
    } catch {
      // A partial or malformed diagnostic line is not readiness evidence.
    }
  }
  return latest;
};

const dispatcherReadiness = (
  runDir: string,
  nowMs: number
): UtilityDispatchReadiness => {
  if (!Number.isFinite(nowMs)) {
    return { ready: false, reason: "dispatcher-malformed" };
  }
  const statePath = join(runDir, "governess-state.json");
  let state: Record<string, unknown> | undefined;
  let modifiedAt: number;
  let epoch: string;
  try {
    state = asRecord(JSON.parse(readFileSync(statePath, "utf8")));
    modifiedAt = statSync(statePath).mtimeMs;
    epoch = readFileSync(join(runDir, "utility", "epoch"), "utf8").trim();
  } catch {
    return { ready: false, reason: "dispatcher-missing" };
  }
  if (!(state && Number.isFinite(modifiedAt) && epoch)) {
    return { ready: false, reason: "dispatcher-malformed" };
  }
  if (String(state.governessEpoch ?? "") !== epoch) {
    return { ready: false, reason: "dispatcher-epoch-mismatch" };
  }
  if (nowMs - modifiedAt > DISPATCHER_LEASE_MS || modifiedAt > nowMs + 5000) {
    return {
      evidenceAt: new Date(modifiedAt).toISOString(),
      ready: false,
      reason: "dispatcher-stale",
    };
  }
  return {
    evidenceAt: new Date(modifiedAt).toISOString(),
    ready: true,
    reason: "ready",
  };
};

export const readUtilityDispatchReadiness = (
  runDir: string,
  tierId: UtilityExecutionTierId,
  nowMs = Date.now()
): UtilityDispatchReadiness => {
  const dispatcher = dispatcherReadiness(runDir, nowMs);
  if (!(dispatcher.ready && tierId !== UTILITY_DIRECT_TIER)) {
    return dispatcher;
  }
  const evidence = inferenceEvidence(runDir, tierId);
  if (!evidence) {
    return { ready: false, reason: "inference-unknown" };
  }
  if (evidence.failed) {
    return {
      evidenceAt: evidence.atIso,
      ready: false,
      reason: "inference-failed",
    };
  }
  if (nowMs - evidence.at > INFERENCE_LEASE_MS || evidence.at > nowMs + 5000) {
    return {
      evidenceAt: evidence.atIso,
      ready: false,
      reason: "inference-stale",
    };
  }
  return { evidenceAt: evidence.atIso, ready: true, reason: "ready" };
};

export const utilityInferenceCircuitOpen = (
  runDir: string,
  tierId: UtilityExecutionTierId,
  nowMs = Date.now()
): boolean => {
  if (tierId === UTILITY_DIRECT_TIER) {
    return false;
  }
  const evidence = inferenceEvidence(runDir, tierId);
  return Boolean(
    evidence?.failed &&
      nowMs >= evidence.at &&
      nowMs - evidence.at <= INFERENCE_FAILURE_COOLDOWN_MS
  );
};

export const utilityTierConfigured = (
  tierId: UtilityExecutionTierId,
  config: {
    availability: { code: string };
    enabled: boolean;
    nannyAvailability: { code: string };
    nannyEnabled: boolean;
  }
): boolean => {
  if (tierId === UTILITY_DIRECT_TIER) {
    return true;
  }
  if (tierId === UTILITY_NANNY_TIER) {
    return (
      config.nannyEnabled && config.nannyAvailability.code.startsWith("ready-")
    );
  }
  return config.enabled && config.availability.code.startsWith("ready-");
};

export const utilityTierAvailabilityCode = (
  tierId: UtilityExecutionTierId,
  config: {
    availability: { code: string };
    nannyAvailability: { code: string };
  }
): string => {
  if (tierId === UTILITY_NANNY_TIER) {
    return config.nannyAvailability.code;
  }
  if (tierId === UTILITY_AU_PAIR_TIER) {
    return config.availability.code;
  }
  return "ready-direct";
};

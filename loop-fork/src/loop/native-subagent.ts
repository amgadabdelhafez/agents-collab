import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sleepSync } from "bun";
import type { Agent } from "./types";
import {
  isUtilityProtectedPath,
  normalizeUtilityPolicyPath,
  utilityPathWithin,
} from "./utility-path-policy";
import { readUtilityJob } from "./utility-store";

export type NativeSubagentMode = "off" | "strict" | "utility-first";
export type NativeFallbackKind = "explore" | "review";
export type NativeFallbackReason =
  | "independent-review"
  | "utility-context-insufficient"
  | "utility-failed"
  | "utility-ineligible"
  | "human-authorized";
export type NativeFallbackState =
  | "pending"
  | "granted"
  | "consumed"
  | "running"
  | "completed"
  | "denied"
  | "expired";

export const CLAUDE_NATIVE_FALLBACK_PROFILE = "loop-readonly-fallback";
export const CODEX_NATIVE_FALLBACK_PROFILE = "loop_readonly_fallback";
export const CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON =
  "codex-native-readonly-sandbox-unavailable";
export const NATIVE_FALLBACK_GRANT_TTL_MS = 120_000;
export const NATIVE_FALLBACK_RUN_TTL_MS = 300_000;
export const MAX_NATIVE_FALLBACK_READ_SCOPES = 8;
export const MAX_NATIVE_FALLBACK_EVIDENCE_TASKS = 3;

const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 2000;
const LOCK_RETRY_INTERVAL_MS = 5;
const SETTLED_UTILITY_STATES = new Set([
  "routed-driver",
  "routed-peer",
  "routed-requester",
  "completed",
  "failed",
  "escalated",
  "canceled",
]);
const NON_UTILITY_ROUTE_STATES = new Set([
  "routed-driver",
  "routed-peer",
  "routed-requester",
]);
const ACTIVE_NATIVE_STATES = new Set<NativeFallbackState>([
  "granted",
  "consumed",
  "running",
]);

export interface NativeFallbackRequest {
  acceptanceCriteria: string[];
  createdAt: string;
  evidenceTaskIds: string[];
  fallbackReason: NativeFallbackReason;
  humanAuthorized: boolean;
  id: string;
  kind: NativeFallbackKind;
  objective: string;
  readScope: string[];
  requester: Agent;
}

export interface NativeFallbackRequestInput {
  acceptanceCriteria: string[];
  createdAt?: string;
  evidenceTaskIds?: string[];
  fallbackReason: NativeFallbackReason;
  humanAuthorized?: boolean;
  id?: string;
  kind: NativeFallbackKind;
  objective: string;
  readScope: string[];
  requester: Agent;
}

export type NativeFallbackEventType =
  | "requested"
  | "granted"
  | "consumed"
  | "started"
  | "completed"
  | "denied"
  | "expired"
  | "spawn-denied"
  | "child-tool-denied"
  | "orphan-start";

export interface NativeFallbackEvent {
  agentId?: string;
  agentType?: string;
  at: string;
  epoch?: number;
  eventId: string;
  expiresAt?: string;
  leaseId?: string;
  provider?: Agent;
  reason?: string;
  request?: NativeFallbackRequest;
  requestId?: string;
  runtimeExpiresAt?: string;
  state?: NativeFallbackState;
  toolName?: string;
  toolUseId?: string;
  type: NativeFallbackEventType;
}

export interface NativeFallbackSnapshot {
  agentId?: string;
  agentType?: string;
  epoch?: number;
  events: NativeFallbackEvent[];
  expiresAt?: string;
  leaseId?: string;
  provider?: Agent;
  reason?: string;
  request: NativeFallbackRequest;
  runtimeExpiresAt?: string;
  state: NativeFallbackState;
  updatedAt: string;
}

export interface NativeFallbackDecision {
  allowed: boolean;
  lease?: NativeFallbackSnapshot;
  reason: string;
}

export interface NativeFallbackObservability {
  active: number;
  blockedAttempts: number;
  completed: number;
  denied: number;
  expired: number;
  grants: number;
  latestReason?: string;
  mode: NativeSubagentMode;
  requests: number;
  slot: "open" | "granted" | "consumed" | "running";
}

interface NativeFallbackPaths {
  eventsFile: string;
  lockFile: string;
  rootDir: string;
  utilityEpochFile: string;
}

const nativeFallbackPaths = (runDir: string): NativeFallbackPaths => {
  const rootDir = join(runDir, "native-subagents");
  return {
    eventsFile: join(rootDir, "events.jsonl"),
    lockFile: join(rootDir, "events.lock"),
    rootDir,
    utilityEpochFile: join(runDir, "utility", "epoch"),
  };
};

export const resolveNativeSubagentMode = (
  value: string | undefined
): NativeSubagentMode => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "utility-first") {
    return "utility-first";
  }
  if (normalized === "strict" || normalized === "off") {
    return normalized;
  }
  return "strict";
};

export const nativeFallbackProfile = (agent: Agent): string | undefined => {
  if (agent === "claude") {
    return CLAUDE_NATIVE_FALLBACK_PROFILE;
  }
  return agent === "codex" ? CODEX_NATIVE_FALLBACK_PROFILE : undefined;
};

const nonEmptyText = (value: string, label: string, max: number): string => {
  const text = value.trim();
  if (!text || text.length > max) {
    throw new Error(`${label} must contain 1-${max} characters`);
  }
  return text;
};

const boundedTextList = (
  values: readonly string[],
  label: string,
  min: number,
  max: number
): string[] => {
  if (values.length < min || values.length > max) {
    throw new Error(`${label} must contain ${min}-${max} entries`);
  }
  return values.map((value) => nonEmptyText(value, label, 500));
};

const normalizedReadScopes = (values: readonly string[]): string[] => {
  if (values.length < 1 || values.length > MAX_NATIVE_FALLBACK_READ_SCOPES) {
    throw new Error(
      `read_scope must contain 1-${MAX_NATIVE_FALLBACK_READ_SCOPES} paths`
    );
  }
  const normalized = values.map(normalizeUtilityPolicyPath);
  if (
    normalized.some(
      (path) => !path || path === "." || isUtilityProtectedPath(path)
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(
      "read_scope must contain unique non-root repo-relative non-protected paths"
    );
  }
  return normalized;
};

export const createNativeFallbackRequest = (
  input: NativeFallbackRequestInput
): NativeFallbackRequest => {
  const profile = nativeFallbackProfile(input.requester);
  if (!profile) {
    throw new Error("native fallback is available only to Claude or Codex");
  }
  const evidenceTaskIds = [
    ...new Set(
      (input.evidenceTaskIds ?? []).map((value) =>
        nonEmptyText(value, "evidence_task_ids", 200)
      )
    ),
  ];
  if (
    evidenceTaskIds.length > MAX_NATIVE_FALLBACK_EVIDENCE_TASKS ||
    (!input.humanAuthorized && evidenceTaskIds.length < 1)
  ) {
    throw new Error(
      `evidence_task_ids must contain ${input.humanAuthorized ? "0" : "1"}-${MAX_NATIVE_FALLBACK_EVIDENCE_TASKS} task IDs`
    );
  }
  if (input.humanAuthorized && input.fallbackReason !== "human-authorized") {
    throw new Error(
      "human-authorized requests must use fallback_reason=human-authorized"
    );
  }
  if (!input.humanAuthorized && input.fallbackReason === "human-authorized") {
    throw new Error(
      "fallback_reason=human-authorized requires supervisor authorization"
    );
  }
  return {
    acceptanceCriteria: boundedTextList(
      input.acceptanceCriteria,
      "acceptance_criteria",
      1,
      4
    ),
    createdAt: input.createdAt ?? new Date().toISOString(),
    evidenceTaskIds,
    fallbackReason: input.fallbackReason,
    humanAuthorized: Boolean(input.humanAuthorized),
    id: input.id?.trim() || randomUUID(),
    kind: input.kind,
    objective: nonEmptyText(input.objective, "objective", 2000),
    readScope: normalizedReadScopes(input.readScope),
    requester: input.requester,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertEvent = (value: unknown): NativeFallbackEvent => {
  if (!isRecord(value)) {
    throw new Error("native fallback journal contains a non-object event");
  }
  const event = value as unknown as NativeFallbackEvent;
  if (
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.at !== "string" ||
    !event.at ||
    typeof event.type !== "string" ||
    !event.type
  ) {
    throw new Error("native fallback journal contains a malformed event");
  }
  return event;
};

const readEvents = (path: string): NativeFallbackEvent[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => assertEvent(JSON.parse(line) as unknown));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

export const readNativeFallbackEvents = (
  runDir: string
): NativeFallbackEvent[] => readEvents(nativeFallbackPaths(runDir).eventsFile);

const updateSnapshot = (
  current: NativeFallbackSnapshot,
  event: NativeFallbackEvent
): void => {
  current.events.push(event);
  current.updatedAt = event.at;
  if (event.state) {
    current.state = event.state;
  }
  if (event.reason) {
    current.reason = event.reason;
  }
  if (event.epoch !== undefined) {
    current.epoch = event.epoch;
  }
  if (event.leaseId) {
    current.leaseId = event.leaseId;
  }
  if (event.expiresAt) {
    current.expiresAt = event.expiresAt;
  }
  if (event.runtimeExpiresAt) {
    current.runtimeExpiresAt = event.runtimeExpiresAt;
  }
  if (event.provider) {
    current.provider = event.provider;
  }
  if (event.agentId) {
    current.agentId = event.agentId;
  }
  if (event.agentType) {
    current.agentType = event.agentType;
  }
};

const requestSnapshot = (
  event: NativeFallbackEvent
): NativeFallbackSnapshot | undefined =>
  event.type === "requested" && event.request
    ? {
        events: [event],
        request: event.request,
        state: "pending",
        updatedAt: event.at,
      }
    : undefined;

const foldSnapshots = (
  events: readonly NativeFallbackEvent[]
): NativeFallbackSnapshot[] => {
  const snapshots = new Map<string, NativeFallbackSnapshot>();
  for (const event of events) {
    const initial = requestSnapshot(event);
    if (initial) {
      if (snapshots.has(initial.request.id)) {
        throw new Error(
          `duplicate native fallback request: ${initial.request.id}`
        );
      }
      snapshots.set(initial.request.id, initial);
      continue;
    }
    if (!event.requestId) {
      continue;
    }
    const current = snapshots.get(event.requestId);
    if (!current) {
      throw new Error(
        `native fallback event references an unknown request: ${event.requestId}`
      );
    }
    updateSnapshot(current, event);
  }
  return [...snapshots.values()];
};

export const readNativeFallbackRequests = (
  runDir: string
): NativeFallbackSnapshot[] => foldSnapshots(readNativeFallbackEvents(runDir));

const createLock = (
  lockFile: string
): { descriptor: number; token: string } => {
  const token = randomUUID();
  const descriptor = openSync(lockFile, "wx", 0o600);
  writeSync(descriptor, `${token}\n`);
  fsyncSync(descriptor);
  return { descriptor, token };
};

const staleLock = (lockFile: string): boolean => {
  try {
    return Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    return false;
  }
};

const acquireLock = (
  lockFile: string
): { descriptor: number; token: string } => {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      return createLock(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (staleLock(lockFile)) {
        try {
          unlinkSync(lockFile);
        } catch {
          // Another contender may have cleared the stale lock first.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("native fallback store is busy");
      }
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
};

const releaseLock = (
  lockFile: string,
  descriptor: number,
  token: string
): void => {
  closeSync(descriptor);
  try {
    if (readFileSync(lockFile, "utf8").trim() === token) {
      unlinkSync(lockFile);
    }
  } catch {
    // The lock is already gone; a later operation still validates the journal.
  }
};

const withNativeLock = <T>(runDir: string, operation: () => T): T => {
  const paths = nativeFallbackPaths(runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  const lock = acquireLock(paths.lockFile);
  try {
    return operation();
  } finally {
    releaseLock(paths.lockFile, lock.descriptor, lock.token);
  }
};

const appendEvent = (
  path: string,
  event: NativeFallbackEvent,
  events: NativeFallbackEvent[]
): void => {
  if (events.some((candidate) => candidate.eventId === event.eventId)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(event)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  events.push(event);
};

export const appendNativeFallbackRequest = (
  runDir: string,
  request: NativeFallbackRequest
): NativeFallbackSnapshot =>
  withNativeLock(runDir, () => {
    const paths = nativeFallbackPaths(runDir);
    const events = readEvents(paths.eventsFile);
    const existing = foldSnapshots(events).find(
      (snapshot) => snapshot.request.id === request.id
    );
    if (existing) {
      return existing;
    }
    appendEvent(
      paths.eventsFile,
      {
        at: request.createdAt,
        eventId: `request:${request.id}`,
        request,
        requestId: request.id,
        state: "pending",
        type: "requested",
      },
      events
    );
    const snapshot = foldSnapshots(events).find(
      (candidate) => candidate.request.id === request.id
    );
    if (!snapshot) {
      throw new Error("failed to persist native fallback request");
    }
    return snapshot;
  });

const readPositiveEpoch = (path: string): number | undefined => {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const evidenceReady = (
  runDir: string,
  request: NativeFallbackRequest
): string => {
  if (request.humanAuthorized) {
    return "human-authorized";
  }
  for (const taskId of request.evidenceTaskIds) {
    const job = readUtilityJob(runDir, taskId);
    if (!job) {
      return `utility-evidence-missing:${taskId}`;
    }
    if (job.request.requester !== request.requester) {
      return `utility-evidence-wrong-requester:${taskId}`;
    }
    if (!SETTLED_UTILITY_STATES.has(job.state)) {
      return `utility-evidence-not-settled:${taskId}`;
    }
    if (NON_UTILITY_ROUTE_STATES.has(job.state) && !job.decision) {
      return `utility-evidence-decision-missing:${taskId}`;
    }
    if (!(NON_UTILITY_ROUTE_STATES.has(job.state) || job.result)) {
      return `utility-evidence-result-missing:${taskId}`;
    }
  }
  return "ready";
};

const eventForTransition = (
  snapshot: NativeFallbackSnapshot,
  type: NativeFallbackEventType,
  state: NativeFallbackState,
  at: string,
  extra: Partial<NativeFallbackEvent> = {}
): NativeFallbackEvent => ({
  at,
  eventId: `${type}:${snapshot.request.id}:${randomUUID()}`,
  requestId: snapshot.request.id,
  state,
  type,
  ...extra,
});

const expireSnapshots = (
  paths: NativeFallbackPaths,
  events: NativeFallbackEvent[],
  nowMs: number,
  nowIso: string
): void => {
  const activeEpoch = readPositiveEpoch(paths.utilityEpochFile);
  for (const snapshot of foldSnapshots(events)) {
    if (!ACTIVE_NATIVE_STATES.has(snapshot.state)) {
      continue;
    }
    if (!activeEpoch || snapshot.epoch !== activeEpoch) {
      appendEvent(
        paths.eventsFile,
        eventForTransition(snapshot, "expired", "expired", nowIso, {
          reason: "native-fallback-stale-epoch",
        }),
        events
      );
      continue;
    }
    const expiry =
      snapshot.state === "granted"
        ? snapshot.expiresAt
        : snapshot.runtimeExpiresAt;
    if (expiry && Date.parse(expiry) <= nowMs) {
      appendEvent(
        paths.eventsFile,
        eventForTransition(snapshot, "expired", "expired", nowIso, {
          reason:
            snapshot.state === "granted"
              ? "unused-lease-expired"
              : "native-fallback-runtime-expired",
        }),
        events
      );
    }
  }
};

const pendingDenialReason = (input: {
  active?: NativeFallbackSnapshot;
  evidence: string;
  mode: NativeSubagentMode;
  requester: Agent;
}): string | undefined => {
  if (input.mode === "strict") {
    return "strict-mode";
  }
  if (input.mode === "off") {
    return "native-fallback-policy-off";
  }
  if (input.requester === "codex") {
    // Codex 0.145 reapplies the full-access parent's sandbox after loading a
    // custom role. A profile that says read-only is therefore not a read-only
    // child, so Governess must never grant a Codex native lease.
    return CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON;
  }
  if (input.evidence !== "ready" && input.evidence !== "human-authorized") {
    return input.evidence;
  }
  return input.active
    ? `native-slot-busy:${input.active.request.id}`
    : undefined;
};

export const processPendingNativeFallbackRequests = (input: {
  epoch: number;
  mode: NativeSubagentMode;
  nowMs?: number;
  runDir: string;
}): number =>
  withNativeLock(input.runDir, () => {
    const paths = nativeFallbackPaths(input.runDir);
    if (readPositiveEpoch(paths.utilityEpochFile) !== input.epoch) {
      throw new Error("stale Governess epoch cannot grant native fallback");
    }
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const events = readEvents(paths.eventsFile);
    expireSnapshots(paths, events, nowMs, nowIso);
    const pending = foldSnapshots(events).filter(
      (snapshot) => snapshot.state === "pending"
    );
    let processed = 0;
    for (const snapshot of pending) {
      const evidence = evidenceReady(input.runDir, snapshot.request);
      const active = foldSnapshots(events).find((candidate) =>
        ACTIVE_NATIVE_STATES.has(candidate.state)
      );
      const denial = pendingDenialReason({
        active,
        evidence,
        mode: input.mode,
        requester: snapshot.request.requester,
      });
      if (denial) {
        appendEvent(
          paths.eventsFile,
          eventForTransition(snapshot, "denied", "denied", nowIso, {
            epoch: input.epoch,
            reason: denial,
          }),
          events
        );
      } else {
        appendEvent(
          paths.eventsFile,
          eventForTransition(snapshot, "granted", "granted", nowIso, {
            epoch: input.epoch,
            expiresAt: new Date(
              nowMs + NATIVE_FALLBACK_GRANT_TTL_MS
            ).toISOString(),
            leaseId: randomUUID(),
            reason: snapshot.request.fallbackReason,
          }),
          events
        );
      }
      processed += 1;
    }
    return processed;
  });

const recordUnboundEvent = (
  runDir: string,
  event: Omit<NativeFallbackEvent, "at" | "eventId">
): void => {
  withNativeLock(runDir, () => {
    const paths = nativeFallbackPaths(runDir);
    const events = readEvents(paths.eventsFile);
    appendEvent(
      paths.eventsFile,
      {
        ...event,
        at: new Date().toISOString(),
        eventId: `${event.type}:${randomUUID()}`,
      },
      events
    );
  });
};

export const recordNativeFallbackDenial = (
  runDir: string,
  input: {
    agentId?: string;
    agentType?: string;
    provider: Agent;
    reason: string;
    requestId?: string;
    toolName?: string;
    toolUseId?: string;
    type?: "child-tool-denied" | "spawn-denied";
  }
): void =>
  recordUnboundEvent(runDir, {
    agentId: input.agentId,
    agentType: input.agentType,
    provider: input.provider,
    reason: input.reason,
    requestId: input.requestId,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    type: input.type ?? "spawn-denied",
  });

export const consumeNativeFallbackLease = (input: {
  agentType?: string;
  epoch?: number;
  mode: NativeSubagentMode;
  nowMs?: number;
  provider: Agent;
  runDir: string;
  toolName: string;
  toolUseId?: string;
}): NativeFallbackDecision => {
  if (input.mode === "off") {
    return { allowed: true, reason: "native-fallback-policy-off" };
  }
  return withNativeLock(input.runDir, () => {
    const paths = nativeFallbackPaths(input.runDir);
    const events = readEvents(paths.eventsFile);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    expireSnapshots(paths, events, nowMs, nowIso);
    const expectedProfile = nativeFallbackProfile(input.provider);
    const granted = foldSnapshots(events).find(
      (snapshot) =>
        snapshot.state === "granted" &&
        snapshot.request.requester === input.provider
    );
    const deny = (reason: string): NativeFallbackDecision => {
      appendEvent(
        paths.eventsFile,
        {
          agentType: input.agentType,
          at: nowIso,
          eventId: `spawn-denied:${randomUUID()}`,
          provider: input.provider,
          reason,
          requestId: granted?.request.id,
          toolName: input.toolName,
          toolUseId: input.toolUseId,
          type: "spawn-denied",
        },
        events
      );
      return { allowed: false, reason };
    };
    if (input.mode === "strict") {
      return deny("strict-mode");
    }
    if (input.provider === "codex") {
      return deny(CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON);
    }
    if (!granted) {
      return deny("native-lease-missing");
    }
    const activeEpoch = readPositiveEpoch(paths.utilityEpochFile);
    if (
      !activeEpoch ||
      granted.epoch !== activeEpoch ||
      (input.epoch !== undefined && input.epoch !== activeEpoch)
    ) {
      return deny("native-lease-stale-epoch");
    }
    if (!expectedProfile || input.agentType !== expectedProfile) {
      return deny(`native-profile-required:${expectedProfile ?? "none"}`);
    }
    appendEvent(
      paths.eventsFile,
      eventForTransition(granted, "consumed", "consumed", nowIso, {
        agentType: input.agentType,
        provider: input.provider,
        runtimeExpiresAt: new Date(
          nowMs + NATIVE_FALLBACK_RUN_TTL_MS
        ).toISOString(),
        toolName: input.toolName,
        toolUseId: input.toolUseId,
      }),
      events
    );
    const consumed = foldSnapshots(events).find(
      (snapshot) => snapshot.request.id === granted.request.id
    );
    return consumed
      ? { allowed: true, lease: consumed, reason: "native-lease-consumed" }
      : { allowed: false, reason: "native-lease-consume-failed" };
  });
};

export const bindNativeFallbackStart = (input: {
  agentId: string;
  agentType?: string;
  nowMs?: number;
  provider: Agent;
  runDir: string;
}): NativeFallbackDecision =>
  withNativeLock(input.runDir, () => {
    const paths = nativeFallbackPaths(input.runDir);
    const events = readEvents(paths.eventsFile);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    expireSnapshots(paths, events, nowMs, nowIso);
    const consumed = foldSnapshots(events).find(
      (snapshot) =>
        snapshot.state === "consumed" &&
        snapshot.provider === input.provider &&
        snapshot.request.requester === input.provider
    );
    if (
      !consumed ||
      input.agentType !== nativeFallbackProfile(input.provider)
    ) {
      appendEvent(
        paths.eventsFile,
        {
          agentId: input.agentId,
          agentType: input.agentType,
          at: nowIso,
          eventId: `orphan-start:${randomUUID()}`,
          provider: input.provider,
          reason: "unleased-native-child-started",
          requestId: consumed?.request.id,
          type: "orphan-start",
        },
        events
      );
      return { allowed: false, reason: "unleased-native-child-started" };
    }
    appendEvent(
      paths.eventsFile,
      eventForTransition(consumed, "started", "running", nowIso, {
        agentId: input.agentId,
        agentType: input.agentType,
        provider: input.provider,
      }),
      events
    );
    const running = foldSnapshots(events).find(
      (snapshot) => snapshot.request.id === consumed.request.id
    );
    return running
      ? { allowed: true, lease: running, reason: "native-child-bound" }
      : { allowed: false, reason: "native-child-bind-failed" };
  });

export const completeNativeFallback = (input: {
  agentId: string;
  nowMs?: number;
  provider: Agent;
  runDir: string;
}): NativeFallbackDecision =>
  withNativeLock(input.runDir, () => {
    const paths = nativeFallbackPaths(input.runDir);
    const events = readEvents(paths.eventsFile);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    expireSnapshots(paths, events, nowMs, nowIso);
    const snapshot = foldSnapshots(events).find(
      (candidate) =>
        candidate.agentId === input.agentId &&
        candidate.provider === input.provider &&
        (candidate.state === "running" || candidate.state === "consumed")
    );
    if (!snapshot) {
      return { allowed: false, reason: "native-child-lease-missing" };
    }
    appendEvent(
      paths.eventsFile,
      eventForTransition(snapshot, "completed", "completed", nowIso, {
        agentId: input.agentId,
        provider: input.provider,
        reason: "native-child-stopped",
      }),
      events
    );
    const completed = foldSnapshots(events).find(
      (candidate) => candidate.request.id === snapshot.request.id
    );
    return completed
      ? { allowed: true, lease: completed, reason: "native-child-completed" }
      : { allowed: false, reason: "native-child-complete-failed" };
  });

export const nativeFallbackForChild = (
  runDir: string,
  provider: Agent,
  agentId: string,
  nowMs = Date.now()
): NativeFallbackSnapshot | undefined =>
  withNativeLock(runDir, () => {
    const paths = nativeFallbackPaths(runDir);
    const events = readEvents(paths.eventsFile);
    expireSnapshots(paths, events, nowMs, new Date(nowMs).toISOString());
    return foldSnapshots(events).find(
      (snapshot) =>
        snapshot.provider === provider &&
        snapshot.agentId === agentId &&
        snapshot.state === "running"
    );
  });

// Codex 0.145 does not document `agent_id` on child PreToolUse payloads. A
// profile-specific hook is therefore the supported identity boundary: once it
// is running inside the one allowed profile, resolve the only current Codex
// lease instead of trusting an absent or invented payload field.
export const nativeFallbackForProvider = (
  runDir: string,
  provider: Agent,
  nowMs = Date.now()
): NativeFallbackSnapshot | undefined =>
  withNativeLock(runDir, () => {
    const paths = nativeFallbackPaths(runDir);
    const events = readEvents(paths.eventsFile);
    expireSnapshots(paths, events, nowMs, new Date(nowMs).toISOString());
    return foldSnapshots(events).find(
      (snapshot) =>
        snapshot.provider === provider && snapshot.state === "running"
    );
  });

export const nativeFallbackScopeAllows = (
  snapshot: NativeFallbackSnapshot,
  candidate: string
): boolean => {
  const normalized = normalizeUtilityPolicyPath(candidate);
  if (!normalized || isUtilityProtectedPath(normalized)) {
    return false;
  }
  return snapshot.request.readScope.some((scope) =>
    utilityPathWithin(normalized, scope)
  );
};

export const readNativeFallbackObservability = (
  runDir: string,
  mode: NativeSubagentMode
): NativeFallbackObservability => {
  const events = readNativeFallbackEvents(runDir);
  const snapshots = foldSnapshots(events);
  const active = snapshots.filter((snapshot) =>
    ACTIVE_NATIVE_STATES.has(snapshot.state)
  );
  const slotState = active[0]?.state;
  const latestReason = [...events]
    .reverse()
    .find((event) => event.reason)?.reason;
  return {
    active: active.length,
    blockedAttempts: events.filter(
      (event) =>
        event.type === "spawn-denied" ||
        event.type === "child-tool-denied" ||
        event.type === "orphan-start"
    ).length,
    completed: snapshots.filter((snapshot) => snapshot.state === "completed")
      .length,
    denied: snapshots.filter((snapshot) => snapshot.state === "denied").length,
    expired: snapshots.filter((snapshot) => snapshot.state === "expired")
      .length,
    grants: events.filter((event) => event.type === "granted").length,
    latestReason,
    mode,
    requests: snapshots.length,
    slot:
      slotState === "granted" ||
      slotState === "consumed" ||
      slotState === "running"
        ? slotState
        : "open",
  };
};

export const nativeFallbackStoreExists = (runDir: string): boolean =>
  existsSync(nativeFallbackPaths(runDir).eventsFile);

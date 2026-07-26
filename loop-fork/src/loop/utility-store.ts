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
import type {
  UtilityCompactResult,
  UtilityRouteDecision,
  UtilityRouteRequest,
} from "./task-router";
import type { Agent } from "./types";

export type UtilityJobState =
  | "pending-route"
  | "routed-utility"
  | "routed-driver"
  | "routed-peer"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "escalated"
  | "canceled";

export type UtilityJobEventType =
  | "route-requested"
  | "route-decided"
  | "claimed"
  | "state-transition"
  | "result-recorded"
  | "patch-applied";

export interface UtilityFileImage {
  path: string;
  sha256: string | null;
}

export interface UtilityPatchApplication {
  appliedAt: string;
  appliedBy: Agent;
  manifestPath: string;
  manifestSha256: string;
  patchPath: string;
  patchSha256: string;
  postimages: UtilityFileImage[];
  preimages: UtilityFileImage[];
}

export interface UtilityJobClaim {
  epoch: number;
  workerPid: number;
  workerId: string;
}

export interface UtilityJobEvent {
  application?: UtilityPatchApplication;
  at: string;
  claim?: UtilityJobClaim;
  decision?: UtilityRouteDecision;
  eventId: string;
  jobId: string;
  reason?: string;
  request?: UtilityRouteRequest;
  result?: UtilityCompactResult;
  routeEpoch?: number;
  state: UtilityJobState;
  type: UtilityJobEventType;
}

export interface UtilityJobSnapshot {
  application?: UtilityPatchApplication;
  claim?: UtilityJobClaim;
  decision?: UtilityRouteDecision;
  events: UtilityJobEvent[];
  jobId: string;
  request: UtilityRouteRequest;
  result?: UtilityCompactResult;
  routeEpoch?: number;
  state: UtilityJobState;
  updatedAt: string;
}

export interface UtilityStorePaths {
  epochFile: string;
  eventsFile: string;
  lockFile: string;
  rootDir: string;
}

export interface UtilityTransitionOptions {
  at?: string;
  decision?: UtilityRouteDecision;
  eventId?: string;
  reason?: string;
  result?: UtilityCompactResult;
  routeEpoch?: number;
}

export interface UtilityClaimOptions {
  at?: string;
  eventId?: string;
  jobId?: string;
  workerPid?: number;
  workerId?: string;
}

const LOCK_STALE_AFTER_MS = 30_000;
const LEADING_CURRENT_DIR_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/$/;
const TERMINAL_STATES = new Set<UtilityJobState>([
  "completed",
  "failed",
  "escalated",
  "canceled",
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<UtilityJobState, ReadonlySet<UtilityJobState>>
> = {
  "pending-route": new Set([
    "routed-utility",
    "routed-driver",
    "routed-peer",
    "escalated",
    "canceled",
  ]),
  "routed-utility": new Set(["claimed", "failed", "escalated", "canceled"]),
  "routed-driver": new Set(["completed", "failed", "canceled"]),
  "routed-peer": new Set(["completed", "failed", "canceled"]),
  claimed: new Set(["running", "failed", "escalated", "canceled"]),
  running: new Set(["completed", "failed", "escalated", "canceled"]),
  completed: new Set(),
  failed: new Set(),
  escalated: new Set(),
  canceled: new Set(),
};

export const utilityRunPaths = (runDir: string): UtilityStorePaths => {
  const rootDir = join(runDir, "utility");
  return {
    epochFile: join(rootDir, "epoch"),
    eventsFile: join(rootDir, "jobs.jsonl"),
    lockFile: join(rootDir, "jobs.lock"),
    rootDir,
  };
};

const isPositiveEpoch = (epoch: number): boolean =>
  Number.isInteger(epoch) && epoch > 0;

const normalizeScopePath = (value: string): string =>
  value
    .trim()
    .replaceAll("\\", "/")
    .replace(LEADING_CURRENT_DIR_RE, "")
    .replace(TRAILING_SLASH_RE, "");

const scopeOverlaps = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeScopePath(left);
  const normalizedRight = normalizeScopePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(stableValue(value));

const assertEventShape = (event: UtilityJobEvent): void => {
  if (!(event.eventId.trim() && event.jobId.trim() && event.at.trim())) {
    throw new Error("utility event requires eventId, jobId, and timestamp");
  }
  if (
    event.claim &&
    (!isPositiveEpoch(event.claim.epoch) ||
      !Number.isInteger(event.claim.workerPid) ||
      event.claim.workerPid <= 0)
  ) {
    throw new Error(
      "utility claim requires a positive governess epoch and worker PID"
    );
  }
  if (event.type === "claimed" && !event.claim) {
    throw new Error("claimed utility event requires claim metadata");
  }
  if (
    event.type === "patch-applied" &&
    (!event.application || event.state !== "completed")
  ) {
    throw new Error(
      "patch-applied utility event requires application metadata and completed state"
    );
  }
  if (
    event.state === "routed-utility" &&
    !isPositiveEpoch(event.routeEpoch ?? 0)
  ) {
    throw new Error("utility route requires a positive governess epoch");
  }
  if (
    event.state === "completed" &&
    event.type !== "patch-applied" &&
    event.result?.status !== "completed"
  ) {
    throw new Error("completed utility event requires a completed result");
  }
  if (event.result && event.result.status !== event.state) {
    throw new Error("utility result status must match event state");
  }
};

const readEvents = (eventsFile: string): UtilityJobEvent[] => {
  if (!existsSync(eventsFile)) {
    return [];
  }
  const text = readFileSync(eventsFile, "utf8");
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line) as UtilityJobEvent;
        assertEventShape(parsed);
        return parsed;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `malformed utility event at line ${index + 1}: ${detail}`
        );
      }
    });
};

const snapshotFromEvents = (
  events: readonly UtilityJobEvent[],
  jobId: string
): UtilityJobSnapshot | undefined => {
  const jobEvents = events.filter((event) => event.jobId === jobId);
  const request = jobEvents.find((event) => event.request)?.request;
  const latest = jobEvents.at(-1);
  if (!(request && latest)) {
    return undefined;
  }
  return {
    application: [...jobEvents].reverse().find((event) => event.application)
      ?.application,
    claim: [...jobEvents].reverse().find((event) => event.claim)?.claim,
    decision: [...jobEvents].reverse().find((event) => event.decision)
      ?.decision,
    events: jobEvents,
    jobId,
    request,
    result: [...jobEvents].reverse().find((event) => event.result)?.result,
    routeEpoch: [...jobEvents].reverse().find((event) => event.routeEpoch)
      ?.routeEpoch,
    state: latest.state,
    updatedAt: latest.at,
  };
};

const allSnapshots = (
  events: readonly UtilityJobEvent[]
): UtilityJobSnapshot[] => {
  const jobIds = [...new Set(events.map((event) => event.jobId))];
  return jobIds
    .map((jobId) => snapshotFromEvents(events, jobId))
    .filter((job): job is UtilityJobSnapshot => job !== undefined);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lockIsStale = (lockFile: string): boolean => {
  try {
    const ageMs = Date.now() - statSync(lockFile).mtimeMs;
    const raw = readFileSync(lockFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return (
      ageMs > LOCK_STALE_AFTER_MS ||
      !isPositiveEpoch(pid) ||
      !processIsAlive(pid)
    );
  } catch {
    return true;
  }
};

const withStoreLock = <T>(paths: UtilityStorePaths, operation: () => T): T => {
  mkdirSync(paths.rootDir, { recursive: true });
  let lockDescriptor: number | undefined;
  try {
    try {
      lockDescriptor = openSync(paths.lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (!lockIsStale(paths.lockFile)) {
        throw new Error("utility store is busy");
      }
      unlinkSync(paths.lockFile);
      lockDescriptor = openSync(paths.lockFile, "wx", 0o600);
    }
    writeSync(lockDescriptor, `${process.pid}\n`);
    fsyncSync(lockDescriptor);
    return operation();
  } finally {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      try {
        unlinkSync(paths.lockFile);
      } catch {
        // Another error is already more useful than lock cleanup failure.
      }
    }
  }
};

const validateNewEvent = (
  events: readonly UtilityJobEvent[],
  event: UtilityJobEvent
): UtilityJobSnapshot | undefined => {
  assertEventShape(event);
  const duplicate = events.find(
    (candidate) => candidate.eventId === event.eventId
  );
  if (duplicate) {
    if (stableJson(duplicate) !== stableJson(event)) {
      throw new Error(`utility event id collision: ${event.eventId}`);
    }
    return snapshotFromEvents(events, event.jobId);
  }

  const current = snapshotFromEvents(events, event.jobId);
  if (!current) {
    if (
      event.type !== "route-requested" ||
      event.state !== "pending-route" ||
      !event.request
    ) {
      throw new Error("utility job must begin with a pending route request");
    }
    const reusedRequest = allSnapshots(events).find(
      (job) => job.request.idempotencyKey === event.request?.idempotencyKey
    );
    if (reusedRequest) {
      throw new Error(
        `utility request idempotency key already belongs to ${reusedRequest.jobId}`
      );
    }
    return undefined;
  }
  if (
    event.request &&
    stableJson(event.request) !== stableJson(current.request)
  ) {
    throw new Error(`utility request changed for job ${event.jobId}`);
  }
  if (event.type === "patch-applied") {
    if (current.state !== "completed" || current.result?.status !== "completed") {
      throw new Error("utility patch application requires a completed job");
    }
    return undefined;
  }
  if (!ALLOWED_TRANSITIONS[current.state].has(event.state)) {
    throw new Error(
      `invalid utility transition: ${current.state} -> ${event.state}`
    );
  }
  if (event.type === "claimed" && event.state !== "claimed") {
    throw new Error("claim event must transition to claimed");
  }
  return undefined;
};

const appendLine = (eventsFile: string, event: UtilityJobEvent): void => {
  mkdirSync(dirname(eventsFile), { recursive: true });
  const descriptor = openSync(eventsFile, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(event)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const appendLocked = (
  paths: UtilityStorePaths,
  events: UtilityJobEvent[],
  event: UtilityJobEvent
): UtilityJobSnapshot => {
  const duplicate = validateNewEvent(events, event);
  if (duplicate) {
    return duplicate;
  }
  appendLine(paths.eventsFile, event);
  events.push(event);
  const snapshot = snapshotFromEvents(events, event.jobId);
  if (!snapshot) {
    throw new Error(`failed to materialize utility job ${event.jobId}`);
  }
  return snapshot;
};

export const appendUtilityJobEvent = (
  runDir: string,
  event: UtilityJobEvent
): UtilityJobSnapshot => {
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () =>
    appendLocked(paths, readEvents(paths.eventsFile), event)
  );
};

export const appendUtilityRouteRequest = (
  runDir: string,
  request: UtilityRouteRequest
): UtilityJobSnapshot => {
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () => {
    const events = readEvents(paths.eventsFile);
    const existing = allSnapshots(events).find(
      (job) => job.request.idempotencyKey === request.idempotencyKey
    );
    if (existing) {
      return existing;
    }
    return appendLocked(paths, events, {
      at: request.createdAt,
      eventId: `route:${request.idempotencyKey}`,
      jobId: request.id,
      request,
      state: "pending-route",
      type: "route-requested",
    });
  });
};

export const readUtilityJob = (
  runDir: string,
  jobId: string
): UtilityJobSnapshot | undefined => {
  const paths = utilityRunPaths(runDir);
  return snapshotFromEvents(readEvents(paths.eventsFile), jobId);
};

export const readPendingRouteRequests = (
  runDir: string
): UtilityJobSnapshot[] => {
  const paths = utilityRunPaths(runDir);
  return allSnapshots(readEvents(paths.eventsFile)).filter(
    (job) => job.state === "pending-route"
  );
};

export const readUtilityJobs = (runDir: string): UtilityJobSnapshot[] => {
  const paths = utilityRunPaths(runDir);
  return allSnapshots(readEvents(paths.eventsFile));
};

export const transitionUtilityJob = (
  runDir: string,
  jobId: string,
  state: UtilityJobState,
  options: UtilityTransitionOptions = {}
): UtilityJobSnapshot => {
  if (state === "claimed") {
    throw new Error("use claimUtilityJob for epoch-fenced claims");
  }
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () => {
    const events = readEvents(paths.eventsFile);
    const current = snapshotFromEvents(events, jobId);
    if (!current) {
      throw new Error(`unknown utility job: ${jobId}`);
    }
    if (TERMINAL_STATES.has(current.state)) {
      throw new Error(`utility job is terminal: ${jobId}`);
    }
    return appendLocked(paths, events, {
      at: options.at ?? new Date().toISOString(),
      decision: options.decision,
      eventId: options.eventId ?? randomUUID(),
      jobId,
      reason: options.reason,
      result: options.result,
      routeEpoch: options.routeEpoch,
      state,
      type: options.result ? "result-recorded" : "state-transition",
    });
  });
};

export const recordUtilityPatchApplication = (
  runDir: string,
  jobId: string,
  application: UtilityPatchApplication
): UtilityJobSnapshot => {
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () => {
    const events = readEvents(paths.eventsFile);
    const current = snapshotFromEvents(events, jobId);
    if (!current) {
      throw new Error(`unknown utility job: ${jobId}`);
    }
    const existing = current.events.find(
      (event) =>
        event.type === "patch-applied" &&
        event.application?.patchSha256 === application.patchSha256
    );
    if (existing) {
      const snapshot = snapshotFromEvents(events, jobId);
      if (!snapshot) {
        throw new Error(`failed to materialize utility job ${jobId}`);
      }
      return snapshot;
    }
    return appendLocked(paths, events, {
      application,
      at: application.appliedAt,
      eventId: `patch-application:${jobId}:${application.patchSha256}`,
      jobId,
      state: "completed",
      type: "patch-applied",
    });
  });
};

const readEpochFile = (path: string): number | undefined => {
  try {
    const epoch = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return isPositiveEpoch(epoch) ? epoch : undefined;
  } catch {
    return undefined;
  }
};

export const activateUtilityEpoch = (
  runDir: string,
  epoch: number
): boolean => {
  if (!isPositiveEpoch(epoch)) {
    throw new Error("utility activation requires a positive governess epoch");
  }
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () => {
    const current = readEpochFile(paths.epochFile);
    if (current !== undefined && current > epoch) {
      return false;
    }
    const descriptor = openSync(paths.epochFile, "w", 0o600);
    try {
      writeSync(descriptor, `${epoch}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return true;
  });
};

const hasActiveWriteConflict = (
  candidate: UtilityJobSnapshot,
  jobs: readonly UtilityJobSnapshot[]
): boolean =>
  jobs.some(
    (job) =>
      job.jobId !== candidate.jobId &&
      (job.state === "claimed" || job.state === "running") &&
      candidate.request.writeScope.some((path) =>
        job.request.writeScope.some((claim) => scopeOverlaps(path, claim))
      )
  );

export const claimUtilityJob = (
  runDir: string,
  epoch: number,
  options: UtilityClaimOptions = {}
): UtilityJobSnapshot | undefined => {
  if (!isPositiveEpoch(epoch)) {
    throw new Error("utility claim requires a positive governess epoch");
  }
  const paths = utilityRunPaths(runDir);
  return withStoreLock(paths, () => {
    const events = readEvents(paths.eventsFile);
    const jobs = allSnapshots(events);
    if (readEpochFile(paths.epochFile) !== epoch) {
      return undefined;
    }
    const candidate = jobs.find(
      (job) =>
        job.state === "routed-utility" &&
        job.routeEpoch === epoch &&
        (!options.jobId || job.jobId === options.jobId) &&
        !hasActiveWriteConflict(job, jobs)
    );
    if (!candidate) {
      return undefined;
    }
    const workerId = options.workerId?.trim() || "utility";
    const workerPid = options.workerPid ?? process.pid;
    if (!(Number.isInteger(workerPid) && workerPid > 0)) {
      throw new Error("utility claim requires a positive worker PID");
    }
    return appendLocked(paths, events, {
      at: options.at ?? new Date().toISOString(),
      claim: { epoch, workerId, workerPid },
      eventId:
        options.eventId ?? `claim:${candidate.jobId}:${epoch}:${workerId}`,
      jobId: candidate.jobId,
      state: "claimed",
      type: "claimed",
    });
  });
};

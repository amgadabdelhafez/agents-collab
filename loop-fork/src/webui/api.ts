import type { WebUiSnapshotDTO } from "./types";
import { WEBUI_DTO_VERSION } from "./types";

const LIVE_SNAPSHOT_PATH = "/api/v1/live-snapshot";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RUN_LIFECYCLES = new Set([
  "submitted",
  "working",
  "reviewing",
  "input-required",
  "blocked",
  "completed",
  "failed",
  "stopped",
]);
const AGENT_LIFECYCLES = new Set([
  "starting",
  "working",
  "waiting-human",
  "waiting-peer",
  "reviewing",
  "limited",
  "stuck",
  "crashed",
  "finished",
]);
const QUALITY_SEVERITIES = new Set([
  "healthy",
  "partial",
  "stale",
  "conflict",
  "corrupt",
]);
const SOURCE_STATES = new Set([
  "current",
  "stale",
  "missing",
  "conflict",
  "corrupt",
  "disabled",
  "not-applicable",
]);
const SOURCE_KINDS = new Set([
  "manifest",
  "hook-journal",
  "governess-journal",
  "bridge-journal",
  "worker-journal",
  "usage-snapshot",
  "adapter-probe",
]);
const CONNECTION_STATES = new Set([
  "live",
  "behind",
  "reconnecting",
  "paused",
  "offline",
]);
const ADAPTER_STATES = new Set([
  "healthy",
  "unknown",
  "mismatch",
  "surviving",
  "ended",
]);
const AGENT_ROLES = new Set(["driver", "reviewer"]);
const WORKER_TIERS = new Set(["direct", "nanny", "au-pair"]);
const WORKER_STATES = new Set([
  "queued",
  "active",
  "completed",
  "escalated",
  "failed",
  "canceled",
]);
const BRIDGE_STATUSES = new Set([
  "delivered",
  "pending",
  "failed",
  "superseded",
  "expired",
]);
const RUN_REASON_CODES = new Set([
  "input-required",
  "failed-control",
  "stale-authority",
  "corrupt-evidence",
  "identity-conflict",
  "surviving-adapter",
  "active-looking-manifest",
  "stream-behind",
  "audit-partial",
]);
const RUN_ROUTE_ID_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,114}-[0-9a-f]{12}:[1-9][0-9]{0,11}$/u;

const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isOptionalNonnegativeNumber = (value: unknown): boolean =>
  value === undefined || (isFiniteNumber(value) && value >= 0);
const isIso = (value: unknown): value is string =>
  isString(value) && Number.isFinite(Date.parse(value));
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);
const arrayOf = (value: unknown, guard: (candidate: unknown) => boolean) =>
  Array.isArray(value) && value.every(guard);
const isMember = (set: ReadonlySet<string>, value: unknown): boolean =>
  isString(value) && set.has(value);

export const isRunRouteId = (value: unknown): value is string =>
  isString(value) && RUN_ROUTE_ID_PATTERN.test(value);

const isProvenance = (value: unknown): boolean =>
  isRecord(value) &&
  isIso(value.observedAt) &&
  isString(value.revision) &&
  isString(value.sourceId) &&
  isMember(SOURCE_KINDS, value.sourceKind) &&
  isMember(SOURCE_STATES, value.state) &&
  (value.note === undefined || isString(value.note));

const isConnection = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.label) &&
  isIso(value.lastEventAt) &&
  isIso(value.lastObservedAt) &&
  isFiniteNumber(value.queuedUpdates) &&
  isMember(CONNECTION_STATES, value.state) &&
  isString(value.streamEpoch) &&
  isFiniteNumber(value.streamSequence);

const isDataSource = (value: unknown): boolean =>
  isRecord(value) &&
  isIso(value.generatedAt) &&
  value.kind === "live-redacted" &&
  isString(value.notice) &&
  isString(value.scenario);

const isQuality = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.label) &&
  isMember(QUALITY_SEVERITIES, value.severity) &&
  arrayOf(value.sources, isProvenance) &&
  isString(value.summary);

const isAdapter = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === "tmux" || value.kind === "native") &&
  isString(value.label) &&
  isIso(value.lastProbedAt) &&
  isMember(ADAPTER_STATES, value.state);

const isFleetAgent = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.displayName) &&
  isString(value.id) &&
  isMember(AGENT_LIFECYCLES, value.lifecycle) &&
  isMember(AGENT_ROLES, value.role);

const isRunReason = (value: unknown): boolean =>
  isRecord(value) &&
  isMember(RUN_REASON_CODES, value.code) &&
  isString(value.detail) &&
  isString(value.label) &&
  ["critical", "high", "medium", "low"].includes(String(value.severity));

const isFleetRun = (value: unknown): boolean => {
  if (
    !(
      isRecord(value) &&
      arrayOf(value.adapters, isAdapter) &&
      arrayOf(value.agents, isFleetAgent) &&
      isConnection(value.connection) &&
      isDataSource(value.dataSource) &&
      isString(value.driver) &&
      isIso(value.lastDurableEventAt) &&
      isMember(RUN_LIFECYCLES, value.lifecycle) &&
      isQuality(value.quality) &&
      arrayOf(value.reasons, isRunReason) &&
      [
        value.repoId,
        value.repository,
        value.reviewer,
        value.routeId,
        value.runId,
        value.title,
        value.worktree,
      ].every(isString) &&
      isIso(value.startedAt) &&
      value.version === WEBUI_DTO_VERSION
    )
  ) {
    return false;
  }

  return (
    isRunRouteId(value.routeId) &&
    value.routeId === `${String(value.repoId)}:${String(value.runId)}`
  );
};

const isUsage = (value: unknown): boolean =>
  isRecord(value) &&
  [
    value.cachedTokens,
    value.contextPercent,
    value.costUsd,
    value.inputTokens,
    value.outputTokens,
  ].every(
    (candidate) => candidate === undefined || isFiniteNumber(candidate)
  ) &&
  isFiniteNumber(value.compactions) &&
  Array.isArray(value.windows) &&
  value.windows.every(
    (window) =>
      isRecord(window) &&
      (window.kind === "session" || window.kind === "weekly") &&
      isProvenance(window.provenance) &&
      (window.resetAt === undefined || isIso(window.resetAt)) &&
      ["known", "unknown", "stale"].includes(String(window.resetState)) &&
      isFiniteNumber(window.usedPercent)
  );

const isBridgeMessage = (value: unknown): boolean =>
  isRecord(value) &&
  isIso(value.at) &&
  (value.direction === "sent" || value.direction === "received") &&
  isMember(BRIDGE_STATUSES, value.status) &&
  isString(value.summary);

const isAgent = (value: unknown): boolean =>
  isRecord(value) &&
  [
    value.currentTask,
    value.displayName,
    value.id,
    value.lastHookEvent,
    value.model,
    value.provider,
    value.reasoningEffort,
    value.taskSource,
  ].every(isString) &&
  isIso(value.lastHookAt) &&
  isIso(value.taskObservedAt) &&
  isMember(AGENT_LIFECYCLES, value.lifecycle) &&
  isMember(AGENT_ROLES, value.role) &&
  arrayOf(value.provenance, isProvenance) &&
  isFiniteNumber(value.toolsInFlight) &&
  isUsage(value.usage) &&
  (value.latestBridgeMessage === undefined ||
    isBridgeMessage(value.latestBridgeMessage));

const isWorkerTier = (value: unknown): boolean => {
  if (!(isRecord(value) && isMember(WORKER_TIERS, value.tier))) {
    return false;
  }
  const counts = value.counts;
  return (
    isString(value.description) &&
    isString(value.label) &&
    isRecord(counts) &&
    [
      counts.active,
      counts.canceled,
      counts.completed,
      counts.escalated,
      counts.failed,
      counts.queued,
    ].every(isFiniteNumber) &&
    Array.isArray(value.activity) &&
    value.activity.every(
      (activity) =>
        isRecord(activity) &&
        isString(activity.id) &&
        isIso(activity.startedAt) &&
        (activity.finishedAt === undefined || isIso(activity.finishedAt)) &&
        [activity.costUsd, activity.modelCalls, activity.tokens].every(
          isOptionalNonnegativeNumber
        ) &&
        isMember(WORKER_STATES, activity.state) &&
        isMember(WORKER_TIERS, activity.tier) &&
        isStringArray(activity.artifactEvidenceIds) &&
        [
          activity.contextCapsule,
          activity.requestSummary,
          activity.resultSummary,
          activity.routingReason,
          activity.toolSummary,
        ].every(isString)
    )
  );
};

const structurallyEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (!(isRecord(left) && isRecord(right))) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && structurallyEqual(left[key], right[key])
    )
  );
};

const isEvidence = (value: unknown): boolean =>
  isRecord(value) &&
  isFiniteNumber(value.byteCount) &&
  isIso(value.capturedAt) &&
  isString(value.id) &&
  ["log", "test", "review", "control", "artifact"].includes(
    String(value.kind)
  ) &&
  (value.mimeType === "text/plain" || value.mimeType === "application/json") &&
  isProvenance(value.provenance) &&
  isFiniteNumber(value.redactionsApplied) &&
  isString(value.summary) &&
  isString(value.title);

const isTimelineEvent = (value: unknown): boolean =>
  isRecord(value) &&
  [value.actor, value.detail, value.id, value.title].every(isString) &&
  isIso(value.at) &&
  [
    "lifecycle",
    "agent",
    "bridge",
    "governess",
    "worker",
    "evidence",
    "adapter",
  ].includes(String(value.category)) &&
  isStringArray(value.evidenceIds) &&
  isProvenance(value.provenance) &&
  isFiniteNumber(value.sequence) &&
  ["neutral", "info", "success", "warning", "danger"].includes(
    String(value.tone)
  );

const isGoverness = (value: unknown): boolean =>
  isRecord(value) &&
  Array.isArray(value.audit) &&
  value.audit.every(
    (entry) =>
      isRecord(entry) &&
      [
        entry.acknowledgement,
        entry.controlId,
        entry.evidenceId,
        entry.phase,
        entry.transport,
      ].every(isString) &&
      isIso(entry.at)
  ) &&
  isString(value.driverLease) &&
  isString(value.epoch) &&
  Array.isArray(value.facts) &&
  value.facts.every(
    (fact) =>
      isRecord(fact) &&
      [fact.label, fact.value].every(isString) &&
      isProvenance(fact.provenance) &&
      ["ok", "warning", "error", "neutral"].includes(String(fact.status))
  ) &&
  Array.isArray(value.interpretations) &&
  value.interpretations.every(
    (interpretation) =>
      isRecord(interpretation) &&
      isFiniteNumber(interpretation.confidence) &&
      isIso(interpretation.generatedAt) &&
      ["progress", "next", "waiting-human", "judge"].includes(
        String(interpretation.kind)
      ) &&
      [interpretation.source, interpretation.summary].every(isString)
  ) &&
  Array.isArray(value.policies) &&
  value.policies.every(
    (policy) =>
      isRecord(policy) &&
      [policy.reason, policy.releaseLabel, policy.title].every(isString) &&
      ["allowed", "blocked", "confirmation-bound"].includes(
        String(policy.disposition)
      )
  );

const isRunDetail = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const authority = value.authority;
  return (
    arrayOf(value.agents, isAgent) &&
    isRecord(authority) &&
    [
      authority.currentDriver,
      authority.epoch,
      authority.repoId,
      authority.runId,
    ].every(isString) &&
    ["current", "stale", "conflict"].includes(String(authority.leaseState)) &&
    isConnection(value.connection) &&
    isDataSource(value.dataSource) &&
    arrayOf(value.evidence, isEvidence) &&
    isGoverness(value.governess) &&
    isQuality(value.quality) &&
    isFleetRun(value.summary) &&
    arrayOf(value.timeline, isTimelineEvent) &&
    value.version === WEBUI_DTO_VERSION &&
    arrayOf(value.workers, isWorkerTier)
  );
};

export const isWebUiSnapshot = (value: unknown): value is WebUiSnapshotDTO => {
  if (!(isRecord(value) && isRecord(value.fleet) && isRecord(value.details))) {
    return false;
  }
  const fleet = value.fleet;
  const details = value.details;
  if (
    value.version !== WEBUI_DTO_VERSION ||
    value.source !== "loop-registry-live" ||
    fleet.version !== WEBUI_DTO_VERSION ||
    !isConnection(fleet.connection) ||
    !isDataSource(fleet.dataSource) ||
    !isIso(fleet.observedAt) ||
    !isQuality(fleet.quality) ||
    !arrayOf(fleet.runs, isFleetRun)
  ) {
    return false;
  }
  if (!Object.values(details).every(isRunDetail)) {
    return false;
  }

  const runs = fleet.runs as readonly Record<string, unknown>[];
  const routeIds = runs.map((run) => String(run.routeId));
  const uniqueRouteIds = new Set(routeIds);
  const detailKeys = Object.keys(details);
  if (
    uniqueRouteIds.size !== routeIds.length ||
    detailKeys.length !== routeIds.length ||
    detailKeys.some((key) => !uniqueRouteIds.has(key))
  ) {
    return false;
  }

  return runs.every((run) => {
    const routeId = String(run.routeId);
    const detail = details[routeId];
    if (!(isRecord(detail) && isRecord(detail.summary))) {
      return false;
    }

    const authority = detail.authority;
    return (
      structurallyEqual(detail.summary, run) &&
      isRecord(authority) &&
      authority.repoId === run.repoId &&
      authority.runId === run.runId
    );
  });
};

export class LiveSnapshotError extends Error {
  readonly status?: number;

  constructor(status?: number) {
    super("Loop registry live data is unavailable");
    this.name = "LiveSnapshotError";
    this.status = status;
  }
}

export const fetchLiveSnapshot = async (
  signal?: AbortSignal,
  requestKey = 0
): Promise<WebUiSnapshotDTO> => {
  let response: Response;
  try {
    response = await fetch(`${LIVE_SNAPSHOT_PATH}?request=${requestKey}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new LiveSnapshotError();
  }
  if (!response.ok) {
    throw new LiveSnapshotError(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LiveSnapshotError(response.status);
  }
  if (!isWebUiSnapshot(body)) {
    throw new LiveSnapshotError(response.status);
  }
  return body;
};

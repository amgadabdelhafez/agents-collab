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
const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{16}$/u;
const CANONICAL_ISO_PATTERN =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNonnegativeNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;
const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPercentage = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 100;
const isConfidence = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;
const isOptional = (
  value: unknown,
  guard: (candidate: unknown) => boolean
): boolean => value === undefined || guard(value);
const isIso = (value: unknown): value is string => {
  if (!(isString(value) && CANONICAL_ISO_PATTERN.test(value))) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const arrayOf = (value: unknown, guard: (candidate: unknown) => boolean) =>
  Array.isArray(value) && value.every(guard);
const isMember = (set: ReadonlySet<string>, value: unknown): boolean =>
  isString(value) && set.has(value);
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => {
  const ownKeys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.every((key) => required.includes(key) || optional.includes(key))
  );
};

export const isRunRouteId = (value: unknown): value is string =>
  isString(value) && RUN_ROUTE_ID_PATTERN.test(value);

const isEvidenceId = (value: unknown): value is string =>
  isString(value) && EVIDENCE_ID_PATTERN.test(value);

const isEvidenceIdArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isEvidenceId);

const isProvenance = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(
    value,
    ["observedAt", "revision", "sourceId", "sourceKind", "state"],
    ["note"]
  ) &&
  isIso(value.observedAt) &&
  isString(value.revision) &&
  isString(value.sourceId) &&
  isMember(SOURCE_KINDS, value.sourceKind) &&
  isMember(SOURCE_STATES, value.state) &&
  (value.note === undefined || isString(value.note));

const isConnection = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "label",
    "lastEventAt",
    "lastObservedAt",
    "queuedUpdates",
    "state",
    "streamEpoch",
    "streamSequence",
  ]) &&
  isString(value.label) &&
  isIso(value.lastEventAt) &&
  isIso(value.lastObservedAt) &&
  isNonnegativeSafeInteger(value.queuedUpdates) &&
  isMember(CONNECTION_STATES, value.state) &&
  isString(value.streamEpoch) &&
  isNonnegativeSafeInteger(value.streamSequence);

const isDataSource = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["generatedAt", "kind", "notice", "scenario"]) &&
  isIso(value.generatedAt) &&
  value.kind === "live-redacted" &&
  isString(value.notice) &&
  isString(value.scenario);

const isQuality = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["label", "severity", "sources", "summary"]) &&
  isString(value.label) &&
  isMember(QUALITY_SEVERITIES, value.severity) &&
  arrayOf(value.sources, isProvenance) &&
  isString(value.summary);

const isAdapter = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "label", "lastProbedAt", "state"]) &&
  (value.kind === "tmux" || value.kind === "native") &&
  isString(value.label) &&
  isIso(value.lastProbedAt) &&
  isMember(ADAPTER_STATES, value.state);

const isFleetAgent = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["displayName", "id", "lifecycle", "role"]) &&
  isString(value.displayName) &&
  isString(value.id) &&
  isMember(AGENT_LIFECYCLES, value.lifecycle) &&
  isMember(AGENT_ROLES, value.role);

const isRunReason = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["code", "detail", "label", "severity"]) &&
  isMember(RUN_REASON_CODES, value.code) &&
  isString(value.detail) &&
  isString(value.label) &&
  ["critical", "high", "medium", "low"].includes(String(value.severity));

const isFleetRun = (value: unknown): boolean => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        "adapters",
        "agents",
        "connection",
        "dataSource",
        "driver",
        "lastDurableEventAt",
        "lifecycle",
        "quality",
        "reasons",
        "repoId",
        "repository",
        "reviewer",
        "routeId",
        "runId",
        "startedAt",
        "title",
        "version",
        "worktree",
      ]) &&
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

const isUsageWindow = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(
    value,
    ["kind", "provenance", "resetState", "usedPercent"],
    ["resetAt"]
  ) &&
  (value.kind === "session" || value.kind === "weekly") &&
  isProvenance(value.provenance) &&
  isOptional(value.resetAt, isIso) &&
  ["known", "unknown", "stale"].includes(String(value.resetState)) &&
  isPercentage(value.usedPercent);

const isUsage = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(
    value,
    ["compactions", "windows"],
    ["cachedTokens", "contextPercent", "costUsd", "inputTokens", "outputTokens"]
  ) &&
  [value.cachedTokens, value.inputTokens, value.outputTokens].every(
    (candidate) => isOptional(candidate, isNonnegativeSafeInteger)
  ) &&
  isOptional(value.contextPercent, isPercentage) &&
  isOptional(value.costUsd, isNonnegativeNumber) &&
  isNonnegativeSafeInteger(value.compactions) &&
  arrayOf(value.windows, isUsageWindow);

const isBridgeMessage = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["at", "direction", "status", "summary"]) &&
  isIso(value.at) &&
  (value.direction === "sent" || value.direction === "received") &&
  isMember(BRIDGE_STATUSES, value.status) &&
  isString(value.summary);

const isAgent = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(
    value,
    [
      "currentTask",
      "displayName",
      "id",
      "lastHookAt",
      "lastHookEvent",
      "lifecycle",
      "model",
      "provenance",
      "provider",
      "reasoningEffort",
      "role",
      "taskObservedAt",
      "taskSource",
      "toolsInFlight",
      "usage",
    ],
    ["latestBridgeMessage"]
  ) &&
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
  isNonnegativeSafeInteger(value.toolsInFlight) &&
  isUsage(value.usage) &&
  (value.latestBridgeMessage === undefined ||
    isBridgeMessage(value.latestBridgeMessage));

const isWorkerCounts = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "active",
    "canceled",
    "completed",
    "escalated",
    "failed",
    "queued",
  ]) &&
  [
    value.active,
    value.canceled,
    value.completed,
    value.escalated,
    value.failed,
    value.queued,
  ].every(isNonnegativeSafeInteger);

const isWorkerActivity = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(
    value,
    [
      "artifactEvidenceIds",
      "contextCapsule",
      "id",
      "requestSummary",
      "resultSummary",
      "routingReason",
      "startedAt",
      "state",
      "tier",
      "toolSummary",
    ],
    ["costUsd", "finishedAt", "modelCalls", "tokens"]
  ) &&
  isString(value.id) &&
  isIso(value.startedAt) &&
  isOptional(value.finishedAt, isIso) &&
  isOptional(value.costUsd, isNonnegativeNumber) &&
  isOptional(value.modelCalls, isNonnegativeSafeInteger) &&
  isOptional(value.tokens, isNonnegativeSafeInteger) &&
  isMember(WORKER_STATES, value.state) &&
  isMember(WORKER_TIERS, value.tier) &&
  isEvidenceIdArray(value.artifactEvidenceIds) &&
  [
    value.contextCapsule,
    value.requestSummary,
    value.resultSummary,
    value.routingReason,
    value.toolSummary,
  ].every(isString);

const isWorkerTier = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["activity", "counts", "description", "label", "tier"]) &&
  isMember(WORKER_TIERS, value.tier) &&
  isString(value.description) &&
  isString(value.label) &&
  isWorkerCounts(value.counts) &&
  arrayOf(value.activity, isWorkerActivity);

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
  hasExactKeys(value, [
    "byteCount",
    "capturedAt",
    "id",
    "kind",
    "mimeType",
    "provenance",
    "redactionsApplied",
    "summary",
    "title",
  ]) &&
  isNonnegativeSafeInteger(value.byteCount) &&
  isIso(value.capturedAt) &&
  isEvidenceId(value.id) &&
  ["log", "test", "review", "control", "artifact"].includes(
    String(value.kind)
  ) &&
  (value.mimeType === "text/plain" || value.mimeType === "application/json") &&
  isProvenance(value.provenance) &&
  isNonnegativeSafeInteger(value.redactionsApplied) &&
  isString(value.summary) &&
  isString(value.title);

const isTimelineEvent = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "actor",
    "at",
    "category",
    "detail",
    "evidenceIds",
    "id",
    "provenance",
    "sequence",
    "title",
    "tone",
  ]) &&
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
  isEvidenceIdArray(value.evidenceIds) &&
  isProvenance(value.provenance) &&
  isNonnegativeSafeInteger(value.sequence) &&
  ["neutral", "info", "success", "warning", "danger"].includes(
    String(value.tone)
  );

const isGovernessAudit = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "acknowledgement",
    "at",
    "controlId",
    "evidenceId",
    "phase",
    "transport",
  ]) &&
  [value.acknowledgement, value.controlId, value.phase, value.transport].every(
    isString
  ) &&
  isEvidenceId(value.evidenceId) &&
  isIso(value.at);

const isGovernessFact = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["label", "provenance", "status", "value"]) &&
  [value.label, value.value].every(isString) &&
  isProvenance(value.provenance) &&
  ["ok", "warning", "error", "neutral"].includes(String(value.status));

const isGovernessInterpretation = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "confidence",
    "generatedAt",
    "kind",
    "source",
    "summary",
  ]) &&
  isConfidence(value.confidence) &&
  isIso(value.generatedAt) &&
  ["progress", "next", "waiting-human", "judge"].includes(String(value.kind)) &&
  [value.source, value.summary].every(isString);

const isGovernessPolicy = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["disposition", "reason", "releaseLabel", "title"]) &&
  [value.reason, value.title].every(isString) &&
  value.releaseLabel === "Read-only release" &&
  ["allowed", "blocked", "confirmation-bound"].includes(
    String(value.disposition)
  );

const isGoverness = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "audit",
    "driverLease",
    "epoch",
    "facts",
    "interpretations",
    "policies",
  ]) &&
  arrayOf(value.audit, isGovernessAudit) &&
  isString(value.driverLease) &&
  isString(value.epoch) &&
  arrayOf(value.facts, isGovernessFact) &&
  arrayOf(value.interpretations, isGovernessInterpretation) &&
  arrayOf(value.policies, isGovernessPolicy);

const isRunDetail = (value: unknown): boolean => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        "agents",
        "authority",
        "connection",
        "dataSource",
        "evidence",
        "governess",
        "quality",
        "summary",
        "timeline",
        "version",
        "workers",
      ])
    )
  ) {
    return false;
  }
  const authority = value.authority;
  return (
    arrayOf(value.agents, isAgent) &&
    isRecord(authority) &&
    hasExactKeys(authority, [
      "currentDriver",
      "epoch",
      "leaseState",
      "repoId",
      "runId",
    ]) &&
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
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ["details", "fleet", "source", "version"]) &&
      isRecord(value.fleet) &&
      isRecord(value.details)
    )
  ) {
    return false;
  }
  const fleet = value.fleet;
  const details = value.details;
  if (
    !hasExactKeys(fleet, [
      "connection",
      "dataSource",
      "observedAt",
      "quality",
      "runs",
      "version",
    ]) ||
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

import { createHash, randomUUID } from "node:crypto";
import type { Agent } from "./types";
import {
  isUtilityProtectedPath,
  normalizeUtilityPolicyPath,
  utilityPathWithin,
} from "./utility-path-policy";

export type UtilityRequestKind =
  | "inspect"
  | "edit"
  | "command"
  | "review"
  | "design"
  | "authority";

export type UtilityCapability =
  | "inspect"
  | "bounded-command"
  | "scoped-edit"
  | "focused-verify";

export type UtilityRisk = "low" | "medium" | "high" | "unknown";

export type UtilityRouteTarget = "utility" | "driver" | "peer" | "escalate";

export interface UtilityAuthorityFlags {
  credentialAccess?: boolean;
  dependencyChange?: boolean;
  destructive?: boolean;
  migration?: boolean;
  productDecision?: boolean;
  release?: boolean;
  remoteMutation?: boolean;
}

export interface UtilityArtifactRef {
  bytes?: number;
  kind: "diff" | "log" | "report" | "test" | "trace";
  manifestPath?: string;
  manifestSha256?: string;
  path: string;
  sha256?: string;
}

export interface UtilityCheckResult {
  command: string[];
  exitCode: number;
  summary: string;
}

export interface UtilityCompactResult {
  artifactRefs: UtilityArtifactRef[];
  blocker?: string;
  checks: UtilityCheckResult[];
  filesChanged: string[];
  status: "completed" | "failed" | "escalated" | "canceled";
  summary: string;
}

export interface UtilityRouteRequest {
  acceptanceCriteria: string[];
  authority: UtilityAuthorityFlags;
  createdAt: string;
  estimatedCostUsd?: number;
  id: string;
  idempotencyKey: string;
  kind: UtilityRequestKind;
  objective: string;
  readScope: string[];
  requester: Agent;
  requiredCapabilities: UtilityCapability[];
  risk: UtilityRisk;
  writeScope: string[];
}

export type UtilityRouteRequestInput = Omit<
  UtilityRouteRequest,
  "createdAt" | "id" | "idempotencyKey"
> & {
  createdAt?: string;
  id?: string;
  idempotencyKey?: string;
};

export interface UtilityTier {
  /** Higher means cheaper relative to other configured tiers. */
  affordabilityScore?: number;
  capabilities: readonly UtilityCapability[];
  enabled: boolean;
  healthy: boolean;
  id: string;
  /** Higher means lower latency relative to other configured tiers. */
  latencyScore?: number;
  maxJobCostUsd?: number;
  model?: string;
  provider?: string;
  qualityScore?: number;
  throughputScore?: number;
  toolCallQualityScore?: number;
}

export type UtilityTierSelectionStrategy =
  | "balanced"
  | "price"
  | "throughput"
  | "latency"
  | "tool-call-quality";

export interface UtilityRoutingPolicy {
  allowedTierPatterns?: readonly string[];
  costQualityTradeoff?: number;
  defaultFallbackTierId?: string;
  preventPerRequestOverrides?: boolean;
  selectionStrategy?: UtilityTierSelectionStrategy;
}

export interface UtilityRouteContext {
  activeWriteClaims: readonly string[];
  currentDriver: Agent;
  currentEpoch?: number;
  peer: Agent;
  protectedPaths?: readonly string[];
  remainingRunBudgetUsd?: number;
  routingPolicy?: UtilityRoutingPolicy;
  tiers: readonly UtilityTier[];
}

export type UtilityRouteReason =
  | "utility-eligible"
  | "review-needs-peer"
  | "authority-needs-human"
  | "missing-governess-epoch"
  | "unsupported-kind"
  | "request-not-bounded"
  | "risk-not-low"
  | "forbidden-authority"
  | "protected-scope"
  | "write-conflict"
  | "capability-unavailable"
  | "utility-unavailable"
  | "routing-policy-invalid"
  | "budget-exceeded";

export interface UtilityRouteDecision {
  /** Safe operator-facing context added by the runtime after pure routing. */
  detail?: string;
  reason: UtilityRouteReason;
  target: UtilityRouteTarget;
  tierId?: string;
  /** Runtime-verified execution boundary; callers cannot set this directly. */
  workspace?: UtilityResolvedWorkspace;
}

export interface UtilityResolvedWorkspace {
  readScope: string[];
  root: string;
  writeScope: string[];
}

interface RequestFactoryDeps {
  now?: () => string;
  randomId?: () => string;
}

const UTILITY_KINDS = new Set<UtilityRequestKind>([
  "inspect",
  "edit",
  "command",
]);

const normalizePath = normalizeUtilityPolicyPath;

const uniqueTrimmed = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const stableRequestKey = (
  input: Omit<UtilityRouteRequestInput, "createdAt" | "id" | "idempotencyKey">
): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export const createUtilityRouteRequest = (
  input: UtilityRouteRequestInput,
  deps: RequestFactoryDeps = {}
): UtilityRouteRequest => {
  const objective = input.objective.trim();
  const acceptanceCriteria = uniqueTrimmed(input.acceptanceCriteria);
  if (!objective) {
    throw new Error("utility route request objective cannot be empty");
  }

  const requestCore = {
    acceptanceCriteria,
    authority: { ...input.authority },
    estimatedCostUsd: input.estimatedCostUsd,
    kind: input.kind,
    objective,
    readScope: uniqueTrimmed(input.readScope).map(normalizePath),
    requester: input.requester,
    requiredCapabilities: uniqueTrimmed(
      input.requiredCapabilities
    ) as UtilityCapability[],
    risk: input.risk,
    writeScope: uniqueTrimmed(input.writeScope).map(normalizePath),
  };
  const idempotencyKey =
    input.idempotencyKey?.trim() || stableRequestKey(requestCore);
  return {
    ...requestCore,
    createdAt: input.createdAt ?? deps.now?.() ?? new Date().toISOString(),
    id: input.id?.trim() || deps.randomId?.() || randomUUID(),
    idempotencyKey,
  };
};

const isAuthorityRequest = (request: UtilityRouteRequest): boolean =>
  request.kind === "authority" || request.kind === "design";

const hasForbiddenAuthority = (authority: UtilityAuthorityFlags): boolean =>
  Object.values(authority).some((value) => value === true);

const touchesProtectedPath = (
  request: UtilityRouteRequest,
  configured: readonly string[] = []
): boolean =>
  [...request.readScope, ...request.writeScope].some((path) =>
    isUtilityProtectedPath(path, configured)
  );

const overlaps = (left: string, right: string): boolean => {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return (
    utilityPathWithin(normalizedLeft, normalizedRight) ||
    utilityPathWithin(normalizedRight, normalizedLeft)
  );
};

const hasWriteConflict = (
  request: UtilityRouteRequest,
  claims: readonly string[]
): boolean =>
  request.writeScope.some((path) =>
    claims.some((claim) => overlaps(path, claim))
  );

const requestIsBounded = (request: UtilityRouteRequest): boolean => {
  if (!(request.objective.trim() && request.acceptanceCriteria.length > 0)) {
    return false;
  }
  if (request.kind === "inspect") {
    return request.readScope.length > 0 && request.writeScope.length === 0;
  }
  if (request.kind === "edit") {
    return request.writeScope.length > 0;
  }
  if (request.kind === "command") {
    return request.readScope.length > 0 || request.writeScope.length > 0;
  }
  return false;
};

const tierSupports = (
  tier: UtilityTier,
  request: UtilityRouteRequest
): boolean =>
  request.requiredCapabilities.every((capability) =>
    tier.capabilities.includes(capability)
  );

const wildcardMatches = (value: string, pattern: string): boolean => {
  const parts = pattern.split("*");
  if (parts.length === 1) {
    return value === pattern;
  }
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (!part) {
      continue;
    }
    const foundAt = value.indexOf(part, offset);
    if (
      foundAt < 0 ||
      (index === 0 && !pattern.startsWith("*") && foundAt !== 0)
    ) {
      return false;
    }
    offset = foundAt + part.length;
  }
  const lastPart = parts.at(-1) ?? "";
  return pattern.endsWith("*") || value.endsWith(lastPart);
};

const tierAllowedByPolicy = (
  tier: UtilityTier,
  policy: UtilityRoutingPolicy | undefined
): boolean => {
  const patterns = policy?.allowedTierPatterns;
  return (
    !patterns ||
    patterns.length === 0 ||
    patterns.some((pattern) => wildcardMatches(tier.id, pattern.trim()))
  );
};

const routingPolicyIsValid = (
  policy: UtilityRoutingPolicy | undefined
): boolean => {
  const tradeoff = policy?.costQualityTradeoff;
  return (
    tradeoff === undefined ||
    (Number.isFinite(tradeoff) && tradeoff >= 0 && tradeoff <= 10)
  );
};

const budgetAllows = (
  request: UtilityRouteRequest,
  tier: UtilityTier,
  remainingRunBudgetUsd: number | undefined
): boolean => {
  const estimated = request.estimatedCostUsd ?? tier.maxJobCostUsd;
  if (estimated === undefined) {
    return remainingRunBudgetUsd === undefined;
  }
  if (!(Number.isFinite(estimated) && estimated >= 0)) {
    return false;
  }
  return (
    (tier.maxJobCostUsd === undefined || estimated <= tier.maxJobCostUsd) &&
    (remainingRunBudgetUsd === undefined || estimated <= remainingRunBudgetUsd)
  );
};

const normalizedScore = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.5;

const tierScore = (
  tier: UtilityTier,
  policy: UtilityRoutingPolicy | undefined
): number => {
  const strategy = policy?.selectionStrategy ?? "balanced";
  if (strategy === "price") {
    return normalizedScore(tier.affordabilityScore);
  }
  if (strategy === "throughput") {
    return normalizedScore(tier.throughputScore);
  }
  if (strategy === "latency") {
    return normalizedScore(tier.latencyScore);
  }
  if (strategy === "tool-call-quality") {
    return normalizedScore(tier.toolCallQualityScore);
  }
  const costWeight = (policy?.costQualityTradeoff ?? 5) / 10;
  return (
    normalizedScore(tier.qualityScore) * (1 - costWeight) +
    normalizedScore(tier.affordabilityScore) * costWeight
  );
};

const selectTier = (
  tiers: readonly UtilityTier[],
  policy: UtilityRoutingPolicy | undefined
): UtilityTier | undefined => {
  const fallbackTierId = policy?.defaultFallbackTierId;
  return [...tiers].sort((left, right) => {
    const scoreDelta = tierScore(right, policy) - tierScore(left, policy);
    if (Math.abs(scoreDelta) > Number.EPSILON) {
      return scoreDelta;
    }
    if (left.id === fallbackTierId) {
      return -1;
    }
    if (right.id === fallbackTierId) {
      return 1;
    }
    return 0;
  })[0];
};

const driverDecision = (reason: UtilityRouteReason): UtilityRouteDecision => ({
  reason,
  target: "driver",
});

export const routeUtilityRequest = (
  request: UtilityRouteRequest,
  context: UtilityRouteContext
): UtilityRouteDecision => {
  if (request.kind === "review") {
    return { reason: "review-needs-peer", target: "peer" };
  }
  if (isAuthorityRequest(request)) {
    return { reason: "authority-needs-human", target: "escalate" };
  }
  if (
    !(Number.isInteger(context.currentEpoch) && (context.currentEpoch ?? 0) > 0)
  ) {
    return driverDecision("missing-governess-epoch");
  }
  if (!UTILITY_KINDS.has(request.kind)) {
    return driverDecision("unsupported-kind");
  }
  if (!requestIsBounded(request)) {
    return driverDecision("request-not-bounded");
  }
  if (request.risk !== "low") {
    return driverDecision("risk-not-low");
  }
  if (hasForbiddenAuthority(request.authority)) {
    return { reason: "forbidden-authority", target: "escalate" };
  }
  if (touchesProtectedPath(request, context.protectedPaths)) {
    return driverDecision("protected-scope");
  }
  if (hasWriteConflict(request, context.activeWriteClaims)) {
    return driverDecision("write-conflict");
  }
  if (!routingPolicyIsValid(context.routingPolicy)) {
    return driverDecision("routing-policy-invalid");
  }

  const available = context.tiers.filter(
    (tier) =>
      tierAllowedByPolicy(tier, context.routingPolicy) &&
      tier.enabled &&
      tier.healthy &&
      tierSupports(tier, request)
  );
  if (available.length === 0) {
    const healthyTierExists = context.tiers.some(
      (tier) => tier.enabled && tier.healthy
    );
    return driverDecision(
      healthyTierExists ? "capability-unavailable" : "utility-unavailable"
    );
  }
  const withinBudget = available.filter((candidate) =>
    budgetAllows(request, candidate, context.remainingRunBudgetUsd)
  );
  const tier = selectTier(withinBudget, context.routingPolicy);
  if (!tier) {
    return driverDecision("budget-exceeded");
  }
  return {
    reason: "utility-eligible",
    target: "utility",
    tierId: tier.id,
  };
};

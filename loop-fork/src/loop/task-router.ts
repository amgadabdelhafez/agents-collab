import { createHash, randomUUID } from "node:crypto";
import type { Agent } from "./types";
import {
  isUtilityContextRefPath,
  isUtilityProtectedPath,
  normalizeUtilityPolicyPath,
  utilityPathWithin,
} from "./utility-path-policy";

export const MAX_UTILITY_CONTEXT_REFS = 6;
const LINE_MATCHER_CONTROL_RE = /[\n\r\0]/;

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

export type UtilityExecutionProfile =
  | "file-read"
  | "file-list"
  | "focused-check"
  | "git-diff"
  | "git-inspect"
  | "git-status"
  | "read-plan"
  | "search";

export type UtilityRisk = "low" | "medium" | "high" | "unknown";

export type UtilityRouteTarget =
  | "utility"
  | "driver"
  | "peer"
  | "requester"
  | "escalate";

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

export interface UtilityReadRequest {
  endLine?: number;
  lastLines?: number;
  path: string;
  startLine?: number;
}

export interface UtilityOutputRequest {
  excludeLines?: string[];
  includeLines?: string[];
  lineLimit?: number;
  position?: "head" | "tail";
  stderr?: "merge" | "omit";
  stripAnsi?: boolean;
}

export type UtilityReadPlanProfile = Exclude<
  UtilityExecutionProfile,
  "read-plan"
>;

export interface UtilityReadPlanStep {
  executionArgv?: string[];
  executionCwd?: string;
  executionOutput?: UtilityOutputRequest;
  executionProfile: UtilityReadPlanProfile;
  executionRead?: UtilityReadRequest;
  objective: string;
  readScope: string[];
}

export interface UtilityCompactResult {
  artifactRefs: UtilityArtifactRef[];
  blocker?: string;
  checks: UtilityCheckResult[];
  context?: {
    sha256: string;
    version: number;
  };
  filesChanged: string[];
  paneSummary?: string;
  reasonCode?: "context-insufficient";
  status: "completed" | "failed" | "escalated" | "canceled";
  summary: string;
}

export interface UtilityRouteRequest {
  acceptanceCriteria: string[];
  authority: UtilityAuthorityFlags;
  contextRefs?: string[];
  createdAt: string;
  estimatedCostUsd?: number;
  executionArgv?: string[];
  executionCwd?: string;
  executionOutput?: UtilityOutputRequest;
  executionPlan?: UtilityReadPlanStep[];
  executionProfile?: UtilityExecutionProfile;
  executionRead?: UtilityReadRequest;
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
  routingPolicy?: UtilityRoutingPolicy;
  tiers: readonly UtilityTier[];
}

export type UtilityRouteReason =
  | "utility-eligible"
  | "review-needs-peer"
  | "review-stays-with-requester"
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
  | "routing-policy-invalid";

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
  executionCwd?: string;
  executionOutput?: UtilityOutputRequest;
  executionPlan?: UtilityReadPlanStep[];
  executionRead?: UtilityReadRequest;
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
const UTILITY_EXECUTION_PROFILES = new Set<UtilityExecutionProfile>([
  "file-list",
  "file-read",
  "focused-check",
  "git-diff",
  "git-inspect",
  "git-status",
  "read-plan",
  "search",
]);
const UTILITY_READ_PLAN_PROFILES = new Set<UtilityReadPlanProfile>([
  "file-list",
  "file-read",
  "focused-check",
  "git-diff",
  "git-inspect",
  "git-status",
  "search",
]);

const normalizePath = normalizeUtilityPolicyPath;

const uniqueTrimmed = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const normalizedContextRefs = (
  values: readonly string[] | undefined
): string[] =>
  values
    ? [
        ...new Set(
          uniqueTrimmed(values).map((value) =>
            isUtilityContextRefPath(value)
              ? normalizePath(value)
              : value.replaceAll("\\", "/")
          )
        ),
      ].filter(Boolean)
    : [];

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
  const contextRefs = normalizedContextRefs(input.contextRefs);

  const requestCore = {
    acceptanceCriteria,
    authority: { ...input.authority },
    ...(contextRefs.length > 0 ? { contextRefs } : {}),
    estimatedCostUsd: input.estimatedCostUsd,
    ...(input.executionArgv ? { executionArgv: [...input.executionArgv] } : {}),
    ...(input.executionCwd
      ? { executionCwd: normalizePath(input.executionCwd) }
      : {}),
    ...(input.executionOutput
      ? { executionOutput: { ...input.executionOutput } }
      : {}),
    ...(input.executionPlan
      ? {
          executionPlan: input.executionPlan.map((step) => ({
            ...(step.executionArgv
              ? { executionArgv: [...step.executionArgv] }
              : {}),
            ...(step.executionCwd
              ? { executionCwd: normalizePath(step.executionCwd) }
              : {}),
            ...(step.executionOutput
              ? { executionOutput: { ...step.executionOutput } }
              : {}),
            executionProfile: step.executionProfile,
            ...(step.executionRead
              ? {
                  executionRead: {
                    ...step.executionRead,
                    path: normalizePath(step.executionRead.path),
                  },
                }
              : {}),
            objective: step.objective.trim(),
            readScope: uniqueTrimmed(step.readScope).map(normalizePath),
          })),
        }
      : {}),
    ...(input.executionProfile
      ? { executionProfile: input.executionProfile }
      : {}),
    ...(input.executionRead
      ? {
          executionRead: {
            ...input.executionRead,
            path: normalizePath(input.executionRead.path),
          },
        }
      : {}),
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
  [
    ...request.readScope,
    ...request.writeScope,
    ...(request.executionCwd ? [request.executionCwd] : []),
    ...(typeof request.executionRead?.path === "string"
      ? [request.executionRead.path]
      : []),
    ...(Array.isArray(request.executionPlan)
      ? request.executionPlan.flatMap((step) => [
          ...(Array.isArray(step.readScope) ? step.readScope : []),
          ...(typeof step.executionCwd === "string" ? [step.executionCwd] : []),
          ...(typeof step.executionRead?.path === "string"
            ? [step.executionRead.path]
            : []),
        ])
      : []),
  ].some((path) => isUtilityProtectedPath(path, configured));

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

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const executionReadValueIsBounded = (
  input: unknown,
  readScope: readonly string[]
): boolean => {
  if (input === undefined) {
    return true;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["endLine", "lastLines", "path", "startLine"].includes(key)
    ) ||
    typeof value.path !== "string" ||
    value.path.trim().length === 0 ||
    !readScope.includes(value.path)
  ) {
    return false;
  }
  if (value.lastLines !== undefined) {
    return (
      value.startLine === undefined &&
      value.endLine === undefined &&
      positiveSafeInteger(value.lastLines) &&
      value.lastLines <= 500
    );
  }
  return (
    positiveSafeInteger(value.startLine) &&
    positiveSafeInteger(value.endLine) &&
    value.endLine >= value.startLine &&
    value.endLine - value.startLine + 1 <= 500
  );
};

const executionReadIsBounded = (request: UtilityRouteRequest): boolean =>
  executionReadValueIsBounded(request.executionRead, request.readScope);

const focusedCheckFieldsAreBounded = (
  argv: readonly string[] | undefined,
  cwd: string | undefined,
  readScope: readonly string[]
): boolean => {
  if (!(argv && cwd)) {
    return false;
  }
  let pathStart: number | undefined;
  let requiredPathCount: number | undefined;
  if (argv[0] === "bun" && argv[1] === "test") {
    pathStart = 2;
  } else if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "run") {
    pathStart = 3;
  } else if (argv[0] === "node" && argv[1] === "--check") {
    pathStart = 2;
    requiredPathCount = 1;
  }
  if (pathStart === undefined) {
    return false;
  }
  const paths = argv.slice(pathStart);
  if (
    paths.length < 1 ||
    paths.length > 4 ||
    (requiredPathCount !== undefined && paths.length !== requiredPathCount) ||
    paths.some((path) => path.startsWith("-") || !readScope.includes(path))
  ) {
    return false;
  }
  const exactScopes = new Set([cwd, ...paths]);
  return readScope.every((scope) => exactScopes.has(scope));
};

const focusedCheckIsBounded = (request: UtilityRouteRequest): boolean => {
  if (request.kind !== "command") {
    return false;
  }
  return focusedCheckFieldsAreBounded(
    request.executionArgv,
    request.executionCwd,
    request.readScope
  );
};

const executionOutputValueIsBounded = (
  input: unknown,
  profile: unknown
): boolean => {
  if (input === undefined) {
    return true;
  }
  if (
    profile === undefined ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return false;
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "excludeLines",
          "includeLines",
          "lineLimit",
          "position",
          "stderr",
          "stripAnsi",
        ].includes(key)
    )
  ) {
    return false;
  }
  const hasLineFilter =
    value.lineLimit !== undefined || value.position !== undefined;
  const validLineFilter =
    positiveSafeInteger(value.lineLimit) &&
    (value.lineLimit as number) <= 500 &&
    (value.position === "head" || value.position === "tail");
  const validStderr =
    value.stderr === undefined ||
    value.stderr === "merge" ||
    value.stderr === "omit";
  const validLineMatchers = (candidate: unknown): boolean =>
    candidate === undefined ||
    (Array.isArray(candidate) &&
      candidate.length >= 1 &&
      candidate.length <= 16 &&
      candidate.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length >= 1 &&
          entry.length <= 80 &&
          !LINE_MATCHER_CONTROL_RE.test(entry)
      ));
  const validStripAnsi =
    value.stripAnsi === undefined || typeof value.stripAnsi === "boolean";
  const hasCommandPresentation =
    value.stripAnsi !== undefined ||
    value.includeLines !== undefined ||
    value.excludeLines !== undefined;
  return (
    validStderr &&
    validStripAnsi &&
    validLineMatchers(value.includeLines) &&
    validLineMatchers(value.excludeLines) &&
    (!hasCommandPresentation || profile === "focused-check") &&
    (hasLineFilter
      ? validLineFilter
      : value.stderr !== undefined ||
        value.stripAnsi === true ||
        value.includeLines !== undefined ||
        value.excludeLines !== undefined)
  );
};

const executionOutputIsBounded = (request: UtilityRouteRequest): boolean =>
  executionOutputValueIsBounded(
    request.executionOutput,
    request.executionProfile
  );

const READ_PLAN_STEP_KEYS = new Set([
  "executionOutput",
  "executionArgv",
  "executionCwd",
  "executionProfile",
  "executionRead",
  "objective",
  "readScope",
]);

const executionPlanProfileFieldsAreBounded = (
  step: Record<string, unknown>,
  scopes: string[]
): boolean => {
  if (step.executionProfile === "focused-check") {
    return focusedCheckFieldsAreBounded(
      step.executionArgv as string[] | undefined,
      step.executionCwd as string | undefined,
      scopes
    );
  }
  if (step.executionArgv !== undefined || step.executionCwd !== undefined) {
    return false;
  }
  if (
    step.executionProfile !== "file-read" &&
    step.executionRead !== undefined
  ) {
    return false;
  }
  return !(
    (step.executionProfile === "git-inspect" ||
      step.executionProfile === "git-status") &&
    (scopes.length !== 1 || scopes[0] !== ".")
  );
};

const executionPlanStepIsBounded = (
  rawStep: unknown
): rawStep is UtilityReadPlanStep => {
  if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
    return false;
  }
  const step = rawStep as Record<string, unknown>;
  if (
    Object.keys(step).some((key) => !READ_PLAN_STEP_KEYS.has(key)) ||
    typeof step.executionProfile !== "string" ||
    !UTILITY_READ_PLAN_PROFILES.has(
      step.executionProfile as UtilityReadPlanProfile
    ) ||
    typeof step.objective !== "string" ||
    step.objective.trim().length === 0 ||
    !Array.isArray(step.readScope) ||
    step.readScope.length < 1 ||
    step.readScope.length > 4 ||
    step.readScope.some(
      (scope) => typeof scope !== "string" || scope.trim().length === 0
    )
  ) {
    return false;
  }
  const scopes = step.readScope as string[];
  return (
    executionOutputValueIsBounded(
      step.executionOutput,
      step.executionProfile
    ) &&
    executionReadValueIsBounded(step.executionRead, scopes) &&
    executionPlanProfileFieldsAreBounded(step, scopes)
  );
};

const executionPlanIsBounded = (request: UtilityRouteRequest): boolean => {
  const input = request.executionPlan as unknown;
  if (input === undefined) {
    return request.executionProfile !== "read-plan";
  }
  if (
    request.executionProfile !== "read-plan" ||
    (request.kind !== "inspect" && request.kind !== "command") ||
    request.executionArgv !== undefined ||
    request.executionCwd !== undefined ||
    request.executionOutput !== undefined ||
    request.executionRead !== undefined ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 12
  ) {
    return false;
  }
  const planScope = new Set<string>();
  for (const rawStep of input) {
    if (!executionPlanStepIsBounded(rawStep)) {
      return false;
    }
    for (const scope of rawStep.readScope) {
      planScope.add(scope);
    }
  }
  return (
    (request.kind === "command" ||
      !(input as UtilityReadPlanStep[]).some(
        (step) => step.executionProfile === "focused-check"
      )) &&
    planScope.size <= 12 &&
    planScope.size === request.readScope.length &&
    request.readScope.every((scope) => planScope.has(scope))
  );
};

const executionMetadataIsBounded = (request: UtilityRouteRequest): boolean => {
  const contextRefs = request.contextRefs;
  const contextRefsAreBounded =
    contextRefs === undefined ||
    (Array.isArray(contextRefs) &&
      contextRefs.length <= MAX_UTILITY_CONTEXT_REFS &&
      new Set(contextRefs).size === contextRefs.length &&
      contextRefs.every(
        (ref) => typeof ref === "string" && isUtilityContextRefPath(ref)
      ));
  const profileIsKnown =
    request.executionProfile === undefined ||
    (typeof request.executionProfile === "string" &&
      UTILITY_EXECUTION_PROFILES.has(request.executionProfile));
  const cwdIsBounded =
    request.executionCwd === undefined ||
    (typeof request.executionCwd === "string" &&
      request.executionCwd.trim().length > 0);
  const argvIsBounded =
    request.executionArgv === undefined ||
    (Array.isArray(request.executionArgv) &&
      request.executionArgv.length > 0 &&
      request.executionArgv.every(
        (argument) => typeof argument === "string" && argument.length > 0
      ));
  return (
    contextRefsAreBounded &&
    profileIsKnown &&
    cwdIsBounded &&
    argvIsBounded &&
    executionReadIsBounded(request) &&
    executionOutputIsBounded(request) &&
    executionPlanIsBounded(request)
  );
};

const requestIsBounded = (request: UtilityRouteRequest): boolean => {
  if (!(request.objective.trim() && request.acceptanceCriteria.length > 0)) {
    return false;
  }
  if (!executionMetadataIsBounded(request)) {
    return false;
  }
  if (
    request.executionProfile === "file-read" &&
    request.executionRead === undefined
  ) {
    return false;
  }
  if (
    request.executionProfile !== "file-read" &&
    request.executionRead !== undefined
  ) {
    return false;
  }
  if (
    request.executionProfile === "focused-check" &&
    !focusedCheckIsBounded(request)
  ) {
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
    return request.requester === context.currentDriver
      ? { reason: "review-needs-peer", target: "peer" }
      : { reason: "review-stays-with-requester", target: "requester" };
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
  const tier = selectTier(available, context.routingPolicy);
  return {
    reason: "utility-eligible",
    target: "utility",
    tierId: tier.id,
  };
};

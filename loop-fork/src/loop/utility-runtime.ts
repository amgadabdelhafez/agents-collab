import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn } from "bun";
import { dispatchBridgeMessage } from "./bridge-dispatch";
import { buildLaunchArgv } from "./launch";
import {
  type OpenAICompatibleMessage,
  type OpenAICompatibleToolCall,
  type OpenAICompatibleTraceEvent,
  type OpenAICompatibleUsage,
  openAICompatibleChat,
} from "./openai-compatible";
import { DETACH_CHILD_PROCESS } from "./process";
import {
  routeUtilityRequest,
  type UtilityCheckResult,
  type UtilityCompactResult,
  type UtilityExecutionProfile,
  type UtilityOutputRequest,
  type UtilityReadPlanStep,
  type UtilityReadRequest,
  type UtilityResolvedWorkspace,
  type UtilityRouteRequest,
  type UtilityRoutingPolicy,
  type UtilityTier,
  type UtilityTierSelectionStrategy,
} from "./task-router";
import type { Agent } from "./types";
import {
  readUtilityObservability,
  sanitizeUtilityPaneText,
  type UtilityObservabilitySnapshot,
  type UtilityTranscriptEntry,
} from "./utility-observability";
import {
  activateUtilityEpoch,
  claimUtilityJob,
  readPendingRouteRequests,
  readUtilityJob,
  readUtilityJobs,
  recordUtilityPatchApplication,
  transitionUtilityJob,
  type UtilityJobSnapshot,
} from "./utility-store";
import {
  createUtilityToolBroker,
  type GuardedPatchApplyResult,
  type UtilityArtifactReference,
  type UtilityToolCall,
  type UtilityToolDefinition,
  type UtilityToolName,
  type UtilityToolResult,
} from "./utility-tools";
import {
  resolveUtilityRequestWorkspace,
  verifyAdoptedUtilityWorkspace,
} from "./utility-workspace";

export const UTILITY_WORKER_SUBCOMMAND = "__utility-worker";
export const UTILITY_PANE_SUBCOMMAND = "__utility-pane";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "z-ai/glm-5.2";
const DEFAULT_MAX_CONCURRENT_JOBS = 4;
const MAX_CONSECUTIVE_BROKER_REJECTIONS = 3;
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 3;
const EMERGENCY_MAX_MODEL_CALLS = 64;
const DEFAULT_API_KEY_FILE = join(
  homedir(),
  ".config",
  "loop",
  "openrouter.key"
);

const TOOLS_BY_EXECUTION_PROFILE: Record<
  UtilityExecutionProfile,
  readonly UtilityToolName[]
> = {
  "file-read": ["read_file"],
  "file-list": ["list_files"],
  "focused-check": ["run_check"],
  "git-diff": ["git_diff"],
  "git-inspect": ["git_inspect"],
  "git-status": ["git_status"],
  // A read plan has no fixed tool set. Its broker exposes exactly one tool for
  // the current structured step and advances only after that step succeeds.
  "read-plan": [],
  search: ["search_repo"],
};

export const utilityToolsForExecutionProfile = (
  profile: unknown
): readonly UtilityToolName[] | undefined => {
  if (profile === undefined) {
    return undefined;
  }
  if (
    typeof profile !== "string" ||
    !Object.hasOwn(TOOLS_BY_EXECUTION_PROFILE, profile)
  ) {
    return [];
  }
  return TOOLS_BY_EXECUTION_PROFILE[profile as UtilityExecutionProfile];
};

export interface UtilityRuntimeConfig {
  allowedTierPatterns: string[];
  apiKey?: string;
  availability: UtilityAvailability;
  costQualityTradeoff: number;
  defaultFallbackTierId: string;
  enabled: boolean;
  endpoint: string;
  maxClaimWaitMs: number;
  maxConcurrentJobs: number;
  maxJobRuntimeMs: number;
  model: string;
  preventPerRequestOverrides: boolean;
  providerSort: UtilityTierSelectionStrategy;
}

export interface UtilityAvailability {
  code:
    | "ready-key-file"
    | "ready-environment-key"
    | "ready-local-endpoint"
    | "disabled"
    | "key-file-disabled"
    | "key-file-empty"
    | "key-file-missing"
    | "key-file-not-regular"
    | "key-file-permissions"
    | "key-file-unreadable";
  message: string;
}

export interface UtilityQueueContext {
  currentDriver: Agent;
  epoch: number;
  peer: Agent;
  repoRoot: string;
  runDir: string;
}

export interface UtilityQueueDependencies {
  isWorkerAlive?: (pid: number) => boolean;
  now?: () => number;
  spawnWorker?: (input: {
    env: NodeJS.ProcessEnv;
    epoch: number;
    jobId: string;
    repoRoot: string;
    runDir: string;
  }) => boolean;
  terminateWorker?: (pid: number) => boolean;
}

const utilityWorkerIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const terminateUtilityWorker = (pid: number): boolean => {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
};

const positiveNumber = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedTradeoff = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : 7;
};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  maximum: number
): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
};

const isLoopbackEndpoint = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
};

interface UtilityKeyFileResult {
  availability: UtilityAvailability;
  key?: string;
}

const readUtilityApiKeyFile = (
  path: string | undefined
): UtilityKeyFileResult => {
  if (!path) {
    return {
      availability: {
        code: "key-file-disabled",
        message: "key file loading is disabled",
      },
    };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return {
      availability: {
        code: code === "ENOENT" ? "key-file-missing" : "key-file-unreadable",
        message:
          code === "ENOENT"
            ? `key file missing: ${path}`
            : `key file cannot be read: ${path}`,
      },
    };
  }
  if (!stat.isFile()) {
    return {
      availability: {
        code: "key-file-not-regular",
        message: `key path is not a regular file: ${path}`,
      },
    };
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      availability: {
        code: "key-file-permissions",
        message: `key file permissions are too open; chmod 600 ${path}`,
      },
    };
  }
  let key: string;
  try {
    key = readFileSync(path, "utf8").trim();
  } catch {
    return {
      availability: {
        code: "key-file-unreadable",
        message: `key file cannot be read: ${path}`,
      },
    };
  }
  if (!key) {
    return {
      availability: {
        code: "key-file-empty",
        message: `key file is empty: ${path}`,
      },
    };
  }
  return {
    availability: {
      code: "ready-key-file",
      message: "credential loaded from mode-safe key file",
    },
    key,
  };
};

const utilityApiKey = (env: NodeJS.ProcessEnv): UtilityKeyFileResult => {
  const direct =
    env.OPENROUTER_API_KEY?.trim() || env.LOOP_UTILITY_API_KEY?.trim();
  if (direct) {
    return {
      availability: {
        code: "ready-environment-key",
        message: "credential loaded from process environment",
      },
      key: direct,
    };
  }
  const configuredPath = env.LOOP_UTILITY_API_KEY_FILE;
  const keyFile =
    configuredPath === ""
      ? undefined
      : configuredPath?.trim() || DEFAULT_API_KEY_FILE;
  return readUtilityApiKeyFile(keyFile);
};

const WORKER_ENV_NAMES = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
]);
const UTILITY_SECRET_ENV_NAMES = new Set([
  "LOOP_UTILITY_API_KEY",
  "OPENROUTER_API_KEY",
]);

export const buildUtilityWorkerEnvironment = (
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const minimal: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      !UTILITY_SECRET_ENV_NAMES.has(name) &&
      (WORKER_ENV_NAMES.has(name) || name.startsWith("LOOP_UTILITY_"))
    ) {
      minimal[name] = value;
    }
  }
  minimal.CI = "1";
  minimal.NO_COLOR = "1";
  return minimal;
};

export const resolveUtilityRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): UtilityRuntimeConfig => {
  const endpoint = env.LOOP_UTILITY_URL?.trim() || DEFAULT_ENDPOINT;
  const keyResult = utilityApiKey(env);
  const apiKey = keyResult.key;
  const explicitlyEnabled = env.LOOP_UTILITY_ENABLED;
  const enabled =
    explicitlyEnabled === "0"
      ? false
      : explicitlyEnabled === "1" ||
        Boolean(apiKey) ||
        isLoopbackEndpoint(endpoint);
  const sort = env.LOOP_UTILITY_PROVIDER_SORT;
  const providerSort =
    sort === "price" ||
    sort === "throughput" ||
    sort === "latency" ||
    sort === "tool-call-quality"
      ? sort
      : "balanced";
  return {
    allowedTierPatterns: (env.LOOP_UTILITY_ALLOWED_TIERS ?? "utility-*")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...(apiKey ? { apiKey } : {}),
    availability:
      explicitlyEnabled === "0"
        ? { code: "disabled", message: "disabled by LOOP_UTILITY_ENABLED=0" }
        : isLoopbackEndpoint(endpoint)
          ? {
              code: "ready-local-endpoint",
              message:
                "local OpenAI-compatible endpoint does not require a key",
            }
          : keyResult.availability,
    costQualityTradeoff: boundedTradeoff(env.LOOP_UTILITY_COST_QUALITY),
    defaultFallbackTierId:
      env.LOOP_UTILITY_FALLBACK_TIER?.trim() || "utility-default",
    enabled,
    endpoint,
    maxClaimWaitMs: positiveNumber(env.LOOP_UTILITY_MAX_CLAIM_WAIT_MS, 30_000),
    maxConcurrentJobs: boundedInteger(
      env.LOOP_UTILITY_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENT_JOBS,
      8
    ),
    maxJobRuntimeMs: positiveNumber(env.LOOP_UTILITY_MAX_RUNTIME_MS, 900_000),
    model: env.LOOP_UTILITY_MODEL?.trim() || DEFAULT_MODEL,
    preventPerRequestOverrides: env.LOOP_UTILITY_ALLOW_OVERRIDES !== "1",
    providerSort,
  };
};

const routingPolicy = (config: UtilityRuntimeConfig): UtilityRoutingPolicy => ({
  allowedTierPatterns: config.allowedTierPatterns,
  costQualityTradeoff: config.costQualityTradeoff,
  defaultFallbackTierId: config.defaultFallbackTierId,
  preventPerRequestOverrides: config.preventPerRequestOverrides,
  selectionStrategy: config.providerSort,
});

const openRouterProvider = (
  config: UtilityRuntimeConfig
): { sort?: "price" | "throughput" | "latency" | "exacto" } | undefined => {
  if (
    isLoopbackEndpoint(config.endpoint) ||
    config.providerSort === "balanced"
  ) {
    return undefined;
  }
  return {
    sort:
      config.providerSort === "tool-call-quality"
        ? "exacto"
        : config.providerSort,
  };
};

const runtimeTier = (config: UtilityRuntimeConfig): UtilityTier => ({
  capabilities: ["inspect", "bounded-command", "scoped-edit", "focused-verify"],
  enabled: config.enabled,
  healthy:
    config.enabled &&
    (Boolean(config.apiKey) || isLoopbackEndpoint(config.endpoint)),
  id: "utility-default",
  model: config.model,
  provider: isLoopbackEndpoint(config.endpoint) ? "local" : "openrouter",
});

const workerArgs = (runDir: string, epoch: number, jobId: string): string[] => [
  ...buildLaunchArgv(),
  UTILITY_WORKER_SUBCOMMAND,
  runDir,
  String(epoch),
  jobId,
];

const spawnUtilityWorker = (input: {
  env: NodeJS.ProcessEnv;
  epoch: number;
  jobId: string;
  repoRoot: string;
  runDir: string;
}): boolean => {
  const child = spawn(workerArgs(input.runDir, input.epoch, input.jobId), {
    cwd: input.repoRoot,
    detached: DETACH_CHILD_PROCESS,
    env: input.env,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  if (!(typeof child.pid === "number" && child.pid > 0)) {
    return false;
  }
  child.unref?.();
  return true;
};

const stateForDecision = (
  target: "utility" | "driver" | "peer" | "requester" | "escalate"
):
  | "routed-utility"
  | "routed-driver"
  | "routed-peer"
  | "routed-requester"
  | "escalated" => {
  if (target === "utility") {
    return "routed-utility";
  }
  if (target === "peer") {
    return "routed-peer";
  }
  if (target === "requester") {
    return "routed-requester";
  }
  return target === "escalate" ? "escalated" : "routed-driver";
};

const failUtilityJob = async (
  context: UtilityQueueContext,
  job: UtilityJobSnapshot,
  reason: string
): Promise<void> => {
  const current = readUtilityJob(context.runDir, job.jobId);
  if (
    !current ||
    ["completed", "failed", "escalated", "canceled"].includes(current.state)
  ) {
    return;
  }
  try {
    transitionUtilityJob(context.runDir, job.jobId, "failed", {
      result: {
        artifactRefs: [],
        blocker: reason,
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Worker was fenced and failed closed.",
      },
    });
  } catch (error) {
    const raced = readUtilityJob(context.runDir, job.jobId);
    if (
      raced &&
      ["completed", "failed", "escalated", "canceled"].includes(raced.state)
    ) {
      return;
    }
    throw error;
  }
  await dispatchBridgeMessage(
    context.runDir,
    "utility",
    job.request.requester,
    `Worker result ${job.jobId} failed: ${reason}`,
    undefined,
    undefined,
    { taskId: job.jobId, type: "escalation" }
  );
};

const staleUtilityReason = (input: {
  claimTimedOut: boolean;
  deadWorker: boolean;
  staleEpoch: boolean;
  runTimedOut: boolean;
}): string => {
  if (input.staleEpoch) {
    return "worker claim belongs to a stale governess epoch";
  }
  if (input.deadWorker) {
    return "worker process is no longer alive";
  }
  return input.claimTimedOut
    ? "worker did not claim the routed job"
    : input.runTimedOut
      ? "worker job exceeded its runtime limit and was terminated"
      : "worker failed closed";
};

const recoverStaleUtilityJobs = async (
  context: UtilityQueueContext,
  config: UtilityRuntimeConfig,
  deps: UtilityQueueDependencies
): Promise<void> => {
  const now = deps.now?.() ?? Date.now();
  const isWorkerAlive = deps.isWorkerAlive ?? utilityWorkerIsAlive;
  const terminateWorker = deps.terminateWorker ?? terminateUtilityWorker;
  for (const active of readUtilityJobs(context.runDir).filter((job) =>
    ["routed-utility", "claimed", "running"].includes(job.state)
  )) {
    const updatedAt = Date.parse(active.updatedAt);
    const staleEpoch =
      active.routeEpoch !== context.epoch ||
      (active.claim !== undefined && active.claim.epoch !== context.epoch);
    const claimTimedOut =
      active.state === "routed-utility" &&
      Number.isFinite(updatedAt) &&
      now - updatedAt > config.maxClaimWaitMs;
    const runTimedOut =
      active.state !== "routed-utility" &&
      Number.isFinite(updatedAt) &&
      now - updatedAt > config.maxJobRuntimeMs;
    const workerPid = active.claim?.workerPid;
    const deadWorker =
      active.state !== "routed-utility" &&
      workerPid !== undefined &&
      !isWorkerAlive(workerPid);
    if (staleEpoch || claimTimedOut || deadWorker || runTimedOut) {
      const latest = readUtilityJob(context.runDir, active.jobId);
      if (
        !latest ||
        ["completed", "failed", "escalated", "canceled"].includes(latest.state)
      ) {
        continue;
      }
      if (
        (staleEpoch || runTimedOut) &&
        workerPid !== undefined &&
        isWorkerAlive(workerPid)
      ) {
        terminateWorker(workerPid);
      }
      await failUtilityJob(
        context,
        active,
        staleUtilityReason({
          claimTimedOut,
          deadWorker,
          runTimedOut,
          staleEpoch,
        })
      );
    }
  }
};

const currentUtilityWriteClaims = (
  runDir: string,
  runRoot: string,
  workspaceRoot: string
): string[] =>
  readUtilityJobs(runDir)
    .filter(
      (active) =>
        ["routed-utility", "claimed", "running"].includes(active.state) &&
        (active.decision?.workspace?.root ?? runRoot) === workspaceRoot
    )
    .flatMap(
      (active) =>
        active.decision?.workspace?.writeScope ?? active.request.writeScope
    );

const startRoutedUtilityJob = async (input: {
  context: UtilityQueueContext;
  deps: UtilityQueueDependencies;
  env: NodeJS.ProcessEnv;
  job: UtilityJobSnapshot;
}): Promise<void> => {
  const workspace = input.job.decision?.workspace
    ? verifyAdoptedUtilityWorkspace(
        input.context.repoRoot,
        input.job.decision.workspace
      )
    : undefined;
  if (input.job.decision?.workspace && !workspace) {
    await failUtilityJob(
      input.context,
      input.job,
      "verified worker workspace no longer matches the run repository"
    );
    return;
  }
  const repoRoot = workspace?.root ?? input.context.repoRoot;
  let started = false;
  try {
    started = (input.deps.spawnWorker ?? spawnUtilityWorker)({
      env: input.env,
      epoch: input.context.epoch,
      jobId: input.job.jobId,
      repoRoot,
      runDir: input.context.runDir,
    });
  } catch {
    started = false;
  }
  if (started) {
    return;
  }
  const routedJob = readUtilityJob(input.context.runDir, input.job.jobId);
  if (routedJob) {
    await failUtilityJob(
      input.context,
      routedJob,
      "worker process failed to start"
    );
  }
};

const dispatchNonUtilityRoute = async (
  context: UtilityQueueContext,
  job: UtilityJobSnapshot,
  target: "driver" | "peer" | "requester" | "escalate",
  reason: string
): Promise<void> => {
  if (target === "requester") {
    return;
  }
  const requesterPeer =
    job.request.requester === context.currentDriver
      ? context.peer
      : context.currentDriver;
  const peerRoute = target === "peer";
  const bridgeTarget = peerRoute ? requesterPeer : context.currentDriver;
  const message = peerRoute
    ? [
        `Peer review requested by ${job.request.requester}.`,
        `The worker was not used because this task requires peer judgment (${reason}).`,
        `Objective: ${job.request.objective}`,
        `Action: perform the review and return an explicit verdict to ${job.request.requester} through the loop bridge. Act on this request.`,
      ].join(" ")
    : `Worker route ${job.jobId} returned to ${target}: ${reason}. Objective: ${job.request.objective}`;
  await dispatchBridgeMessage(
    context.runDir,
    peerRoute ? job.request.requester : "utility",
    bridgeTarget,
    message,
    undefined,
    undefined,
    {
      taskId: job.jobId,
      type:
        target === "escalate"
          ? "escalation"
          : peerRoute
            ? "review_request"
            : "work_request",
    }
  );
};

const processPendingUtilityJob = async (input: {
  config: UtilityRuntimeConfig;
  context: UtilityQueueContext;
  deps: UtilityQueueDependencies;
  env: NodeJS.ProcessEnv;
  job: UtilityJobSnapshot;
  utilitySlotAvailable: boolean;
}): Promise<boolean> => {
  const workspaceResolution = ["inspect", "edit", "command"].includes(
    input.job.request.kind
  )
    ? resolveUtilityRequestWorkspace(input.job.request, input.context.repoRoot)
    : { request: input.job.request };
  const routedDecision =
    "detail" in workspaceResolution
      ? {
          detail: workspaceResolution.detail,
          reason: "protected-scope" as const,
          target: "driver" as const,
        }
      : routeUtilityRequest(workspaceResolution.request, {
          activeWriteClaims: currentUtilityWriteClaims(
            input.context.runDir,
            input.context.repoRoot,
            workspaceResolution.workspace?.root ?? input.context.repoRoot
          ),
          currentDriver: input.context.currentDriver,
          currentEpoch: input.context.epoch,
          peer: input.context.peer,
          routingPolicy: routingPolicy(input.config),
          tiers: [runtimeTier(input.config)],
        });
  const decision =
    routedDecision.reason === "utility-unavailable"
      ? { ...routedDecision, detail: input.config.availability.message }
      : routedDecision.target === "utility" &&
          !("detail" in workspaceResolution) &&
          workspaceResolution.workspace
        ? { ...routedDecision, workspace: workspaceResolution.workspace }
        : routedDecision;
  if (decision.target === "utility" && !input.utilitySlotAvailable) {
    return false;
  }
  transitionUtilityJob(
    input.context.runDir,
    input.job.jobId,
    stateForDecision(decision.target),
    {
      decision,
      eventId: `route-decision:${input.context.epoch}:${input.job.jobId}`,
      reason: decision.reason,
      routeEpoch:
        decision.target === "utility" ? input.context.epoch : undefined,
    }
  );
  if (decision.target === "utility") {
    const routedJob = readUtilityJob(input.context.runDir, input.job.jobId);
    await startRoutedUtilityJob({
      ...input,
      job: routedJob ?? input.job,
    });
    return true;
  }
  await dispatchNonUtilityRoute(
    input.context,
    input.job,
    decision.target,
    decision.detail
      ? `${decision.reason} (${decision.detail})`
      : decision.reason
  );
  return false;
};

export const processPendingUtilityRoutes = async (
  context: UtilityQueueContext,
  env: NodeJS.ProcessEnv = process.env,
  deps: UtilityQueueDependencies = {}
): Promise<number> => {
  const workerEnv = buildUtilityWorkerEnvironment(env);
  const config = resolveUtilityRuntimeConfig(workerEnv);
  if (!activateUtilityEpoch(context.runDir, context.epoch)) {
    throw new Error("stale governess epoch cannot activate worker routing");
  }
  await recoverStaleUtilityJobs(context, config, deps);
  const pending = readPendingRouteRequests(context.runDir);
  let activeJobs = readUtilityJobs(context.runDir).filter((job) =>
    ["routed-utility", "claimed", "running"].includes(job.state)
  ).length;
  for (const job of pending) {
    const occupied = await processPendingUtilityJob({
      config,
      context,
      deps,
      env: workerEnv,
      job,
      utilitySlotAvailable: activeJobs < config.maxConcurrentJobs,
    });
    if (occupied) {
      activeJobs += 1;
    }
  }
  return pending.length;
};

const appendJsonl = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
};

const repoRootForRun = (runDir: string): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(runDir, "manifest.json"), "utf8")
    ) as {
      cwd?: unknown;
    };
    if (typeof manifest.cwd === "string" && isAbsolute(manifest.cwd)) {
      return manifest.cwd;
    }
  } catch {
    // The worker will fail closed to its launch cwd when legacy manifests lack cwd.
  }
  return process.cwd();
};

const artifactDirForJob = (
  repoRoot: string,
  runDir: string,
  jobId: string
): string => {
  const candidate = join(runDir, "utility", "artifacts", jobId);
  const rel = relative(repoRoot, candidate);
  return rel && !rel.startsWith("..") && !isAbsolute(rel)
    ? rel
    : join(".loop", "utility-artifacts", jobId);
};

const addUsage = (
  left: OpenAICompatibleUsage,
  right: OpenAICompatibleUsage
): OpenAICompatibleUsage => ({
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  totalTokens: left.totalTokens + right.totalTokens,
  ...((left.cost ?? right.cost) === undefined
    ? {}
    : { cost: (left.cost ?? 0) + (right.cost ?? 0) }),
  ...((left.upstreamInferenceCost ?? right.upstreamInferenceCost) === undefined
    ? {}
    : {
        upstreamInferenceCost:
          (left.upstreamInferenceCost ?? 0) +
          (right.upstreamInferenceCost ?? 0),
      }),
});

const emptyUsage = (): OpenAICompatibleUsage => ({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const utilitySystemPrompt = (): string =>
  [
    "You are the bounded worker beneath two main coding agents.",
    "Do only the declared objective and acceptance criteria. Use tools for evidence.",
    "Never expand scope, access secrets, change dependencies, make product decisions, or perform remote/destructive actions.",
    "For edits, produce a minimal unified diff with propose_patch; it is reviewed/applied by a main agent.",
    "Do not repeat a rejected or identical tool call; change approach once, then stop if no safe tool can make progress.",
    "Finish with a terse result: outcome, evidence/checks, artifact paths, and blocker if any.",
  ].join(" ");

const parseToolArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
};

interface UtilityConversationResult {
  artifacts: UtilityArtifactReference[];
  checks: UtilityCheckResult[];
  durationMs: number;
  modelCalls: number;
  summary: string;
  toolCalls: number;
  toolRounds: number;
  usage: OpenAICompatibleUsage;
}

type UtilityConversationProgress = Pick<
  UtilityConversationResult,
  "durationMs" | "modelCalls" | "toolCalls" | "toolRounds" | "usage"
>;

interface UtilityConversationBroker {
  assertComplete?: () => void;
  readonly definitions: readonly UtilityToolDefinition[];
  execute(call: UtilityToolCall): Promise<UtilityToolResult>;
}

const recordToolResult = (
  name: string,
  result: UtilityToolResult,
  artifacts: UtilityArtifactReference[],
  checks: UtilityCheckResult[]
): void => {
  if (result.artifact) {
    artifacts.push(result.artifact);
  }
  if (name === "run_check") {
    checks.push({
      command: ["allowlisted-check"],
      exitCode: result.exitCode ?? (result.ok ? 0 : 1),
      summary: result.ok
        ? "check completed"
        : (result.error?.message ?? "check failed"),
    });
  }
};

const assertConversationEvidence = (
  request: UtilityRouteRequest,
  successfulTools: ReadonlySet<UtilityToolName>,
  artifacts: readonly UtilityArtifactReference[]
): void => {
  if (request.kind === "edit") {
    if (
      !(
        successfulTools.has("propose_patch") &&
        artifacts.some((artifact) => artifact.path.endsWith(".patch"))
      )
    ) {
      throw new Error(
        "worker edit completed without a validated patch artifact"
      );
    }
    return;
  }
  if (request.kind === "command") {
    if (!successfulTools.has("run_check")) {
      throw new Error(
        "worker command completed without a successful focused check"
      );
    }
    return;
  }
  if (successfulTools.size === 0) {
    throw new Error("worker task completed without repository tool evidence");
  }
};

const executeUtilityToolCall = async (input: {
  broker: UtilityConversationBroker;
  call: OpenAICompatibleToolCall;
  jobId: string;
  toolEventFile: string;
}): Promise<{ name: UtilityToolName; result: UtilityToolResult }> => {
  const name = input.call.function.name as UtilityToolName;
  const result = await input.broker.execute({
    arguments: parseToolArguments(input.call.function.arguments),
    name,
  });
  appendJsonl(input.toolEventFile, {
    artifact: result.artifact,
    at: new Date().toISOString(),
    durationMs: result.durationMs,
    error: result.error,
    exitCode: result.exitCode,
    jobId: input.jobId,
    ok: result.ok,
    tool: name,
  });
  return { name, result };
};

const runUtilityConversation = async (input: {
  broker: UtilityConversationBroker;
  config: UtilityRuntimeConfig;
  jobId: string;
  onProgress: (progress: UtilityConversationProgress) => void;
  request: UtilityRouteRequest;
  toolEventFile: string;
  traceFile: string;
}): Promise<UtilityConversationResult> => {
  const startedAt = Date.now();
  const messages: OpenAICompatibleMessage[] = [
    { content: utilitySystemPrompt(), role: "system" },
    { content: JSON.stringify(input.request), role: "user" },
  ];
  const artifacts: UtilityArtifactReference[] = [];
  const checks: UtilityCheckResult[] = [];
  const successfulTools = new Set<UtilityToolName>();
  let modelCalls = 0;
  let toolCalls = 0;
  let toolRounds = 0;
  let consecutiveBrokerRejections = 0;
  let lastToolCallFingerprint = "";
  let repeatedToolCallCount = 0;
  let usage = emptyUsage();
  const progress = (): UtilityConversationProgress => ({
    durationMs: Math.max(0, Date.now() - startedAt),
    modelCalls,
    toolCalls,
    toolRounds,
    usage,
  });
  // The emergency ceiling is a last-resort runaway fuse, not an ordinary task
  // budget. Governess stale recovery remains the final wall-time boundary.
  while (Date.now() - startedAt <= input.config.maxJobRuntimeMs) {
    if (modelCalls >= EMERGENCY_MAX_MODEL_CALLS) {
      throw new Error(
        `worker stopped at emergency ${EMERGENCY_MAX_MODEL_CALLS}-model-call ceiling without completion`
      );
    }
    const response = await openAICompatibleChat({
      ...(input.config.apiKey ? { apiKey: input.config.apiKey } : {}),
      endpoint: input.config.endpoint,
      messages,
      model: input.config.model,
      onTrace: (event: OpenAICompatibleTraceEvent) =>
        appendJsonl(input.traceFile, { jobId: input.jobId, ...event }),
      ...(openRouterProvider(input.config)
        ? { provider: openRouterProvider(input.config) }
        : {}),
      temperature: 0.1,
      ...(input.broker.definitions.length > 0
        ? {
            toolChoice: "auto" as const,
            tools: [...input.broker.definitions],
          }
        : {}),
    });
    modelCalls += 1;
    usage = addUsage(usage, response.usage);
    input.onProgress(progress());
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    messages.push(response.message);
    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      input.broker.assertComplete?.();
      assertConversationEvidence(input.request, successfulTools, artifacts);
      return {
        artifacts,
        checks,
        ...progress(),
        summary: response.message.content?.trim() || "Worker task completed.",
      };
    }
    toolRounds += 1;
    for (const call of calls) {
      const toolCallFingerprint = `${call.function.name}\0${call.function.arguments}`;
      if (toolCallFingerprint === lastToolCallFingerprint) {
        repeatedToolCallCount += 1;
      } else {
        lastToolCallFingerprint = toolCallFingerprint;
        repeatedToolCallCount = 1;
      }
      if (repeatedToolCallCount >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS) {
        throw new Error(
          `worker stopped before third consecutive identical tool call: ${call.function.name}`
        );
      }
      const { name, result } = await executeUtilityToolCall({
        broker: input.broker,
        call,
        jobId: input.jobId,
        toolEventFile: input.toolEventFile,
      });
      toolCalls += 1;
      if (result.ok && (name !== "run_check" || result.exitCode === 0)) {
        successfulTools.add(name);
      }
      recordToolResult(name, result, artifacts, checks);
      if (result.ok) {
        consecutiveBrokerRejections = 0;
      } else {
        consecutiveBrokerRejections += 1;
      }
      input.onProgress(progress());
      if (consecutiveBrokerRejections >= MAX_CONSECUTIVE_BROKER_REJECTIONS) {
        throw new Error(
          `worker stopped after ${MAX_CONSECUTIVE_BROKER_REJECTIONS} consecutive broker rejections without progress (last error: ${result.error?.code ?? "unknown"})`
        );
      }
      messages.push({
        content: JSON.stringify(result),
        name,
        role: "tool",
        tool_call_id: call.id,
      });
    }
  }
  throw new Error("worker exceeded its runtime limit without completion");
};

export const utilityBrokerBoundary = (
  request: UtilityRouteRequest,
  readScopes: readonly string[],
  writeScopes: readonly string[]
): {
  commandCwds?: string[];
  exactCommand?: string[];
  exactRead?: UtilityReadRequest | null;
  outputBoundary?: UtilityOutputRequest;
  readScopes: string[];
} => {
  const allReadScopes = [...readScopes, ...writeScopes];
  const outputBoundary = request.executionOutput;
  if (request.executionProfile === "file-read") {
    return {
      exactRead: request.executionRead ?? null,
      ...(outputBoundary ? { outputBoundary } : {}),
      readScopes: allReadScopes,
    };
  }
  if (request.executionProfile !== "focused-check") {
    return {
      ...(outputBoundary ? { outputBoundary } : {}),
      readScopes: allReadScopes,
    };
  }
  const executionCwd = request.executionCwd;
  return {
    commandCwds: executionCwd ? [executionCwd] : [],
    exactCommand: request.executionArgv ?? [],
    ...(outputBoundary ? { outputBoundary } : {}),
    readScopes: executionCwd
      ? allReadScopes.filter((scope) => scope !== executionCwd)
      : allReadScopes,
  };
};

class UtilityReadPlanToolBroker implements UtilityConversationBroker {
  private currentStep = 0;

  constructor(
    private readonly brokers: readonly Awaited<
      ReturnType<typeof createUtilityToolBroker>
    >[]
  ) {}

  get definitions(): readonly UtilityToolDefinition[] {
    return this.brokers[this.currentStep]?.definitions ?? [];
  }

  async execute(call: UtilityToolCall): Promise<UtilityToolResult> {
    const broker = this.brokers[this.currentStep];
    if (!broker) {
      return {
        durationMs: 0,
        error: {
          code: "tool_denied",
          message: "The structured read plan is already complete",
        },
        ok: false,
        tool: call.name,
      };
    }
    const result = await broker.execute(call);
    if (result.ok) {
      this.currentStep += 1;
    }
    return result;
  }

  assertComplete(): void {
    if (this.currentStep !== this.brokers.length) {
      throw new Error(
        `worker stopped before completing structured read step ${this.currentStep + 1} of ${this.brokers.length}`
      );
    }
  }
}

export const createUtilityReadPlanBroker = async (input: {
  artifactDir: string;
  executionPlan: readonly UtilityReadPlanStep[];
  repoRoot: string;
}): Promise<UtilityConversationBroker> => {
  if (input.executionPlan.length < 1) {
    throw new Error("structured read plan cannot be empty");
  }
  const brokers = await Promise.all(
    input.executionPlan.map(async (step) => {
      const allowedTools = utilityToolsForExecutionProfile(
        step.executionProfile
      );
      if (!allowedTools || allowedTools.length !== 1) {
        throw new Error(
          `structured read plan profile is not single-tool: ${step.executionProfile}`
        );
      }
      if (
        (step.executionProfile === "git-inspect" ||
          step.executionProfile === "git-status") &&
        !(step.readScope.length === 1 && step.readScope[0] === ".")
      ) {
        throw new Error(
          `structured ${step.executionProfile} requires explicit repository scope`
        );
      }
      return createUtilityToolBroker({
        allowedTools,
        artifactDir: input.artifactDir,
        ...(step.executionRead ? { exactRead: step.executionRead } : {}),
        ...(step.executionOutput
          ? { outputBoundary: step.executionOutput }
          : {}),
        readScopes: step.readScope,
        repoRoot: input.repoRoot,
        writeScopes: [],
      });
    })
  );
  return new UtilityReadPlanToolBroker(brokers);
};

const executionRequestForWorkspace = (
  request: UtilityRouteRequest,
  workspace: UtilityResolvedWorkspace | undefined
): UtilityRouteRequest => {
  if (!workspace) {
    return request;
  }
  return {
    ...request,
    ...(workspace.executionCwd ? { executionCwd: workspace.executionCwd } : {}),
    ...(workspace.executionOutput
      ? { executionOutput: workspace.executionOutput }
      : {}),
    ...(workspace.executionPlan
      ? { executionPlan: workspace.executionPlan }
      : {}),
    ...(workspace.executionRead
      ? { executionRead: workspace.executionRead }
      : {}),
    readScope: workspace.readScope,
    writeScope: workspace.writeScope,
  };
};

export const runUtilityWorker = async (
  runDir: string,
  epoch: number,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const config = resolveUtilityRuntimeConfig(env);
  const claimed = claimUtilityJob(runDir, epoch, {
    jobId,
    workerId: `utility-${process.pid}`,
    workerPid: process.pid,
  });
  if (!claimed) {
    return;
  }
  transitionUtilityJob(runDir, jobId, "running", {
    eventId: `running:${epoch}:${jobId}`,
  });
  const repoRoot = repoRootForRun(runDir);
  const workspace = claimed.decision?.workspace
    ? verifyAdoptedUtilityWorkspace(repoRoot, claimed.decision.workspace)
    : undefined;
  if (claimed.decision?.workspace && !workspace) {
    await failUtilityJob(
      {
        currentDriver: claimed.request.requester,
        epoch,
        peer: claimed.request.requester,
        repoRoot,
        runDir,
      },
      claimed,
      "verified worker workspace no longer matches the run repository"
    );
    return;
  }
  const executionRoot = workspace?.root ?? repoRoot;
  const readScopes = workspace?.readScope ?? claimed.request.readScope;
  const writeScopes = workspace?.writeScope ?? claimed.request.writeScope;
  const executionRequest = executionRequestForWorkspace(
    claimed.request,
    workspace
  );
  const artifactDir = artifactDirForJob(executionRoot, runDir, jobId);
  const broker =
    executionRequest.executionProfile === "read-plan"
      ? await createUtilityReadPlanBroker({
          artifactDir,
          executionPlan: executionRequest.executionPlan ?? [],
          repoRoot: executionRoot,
        })
      : await (async () => {
          const allowedTools = utilityToolsForExecutionProfile(
            executionRequest.executionProfile
          );
          const brokerBoundary = utilityBrokerBoundary(
            executionRequest,
            readScopes,
            writeScopes
          );
          return createUtilityToolBroker({
            ...(allowedTools ? { allowedTools } : {}),
            artifactDir,
            ...brokerBoundary,
            readScopes: [...new Set(brokerBoundary.readScopes)],
            repoRoot: executionRoot,
            writeScopes,
          });
        })();
  const traceFile = join(runDir, "utility", "llm-trace.jsonl");
  const usageFile = join(runDir, "utility", "usage.jsonl");
  let progress: UtilityConversationProgress = {
    durationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolRounds: 0,
    usage: emptyUsage(),
  };
  try {
    const conversation = await runUtilityConversation({
      broker,
      config,
      jobId,
      onProgress: (next) => {
        progress = next;
      },
      request: executionRequest,
      toolEventFile: join(runDir, "utility", "tool-events.jsonl"),
      traceFile,
    });
    const result: UtilityCompactResult = {
      artifactRefs: conversation.artifacts.map((artifact) => ({
        kind: artifact.path.endsWith(".patch") ? "diff" : "report",
        manifestPath: artifact.manifestPath,
        manifestSha256: artifact.manifestSha256,
        path: artifact.path,
        sha256: artifact.sha256,
      })),
      checks: conversation.checks,
      filesChanged: [],
      status: "completed",
      summary: conversation.summary.slice(0, 4000),
    };
    appendJsonl(usageFile, {
      at: new Date().toISOString(),
      durationMs: conversation.durationMs,
      jobId,
      modelCalls: conversation.modelCalls,
      model: config.model,
      providerSort: config.providerSort,
      status: "completed",
      toolCalls: conversation.toolCalls,
      toolRounds: conversation.toolRounds,
      usage: conversation.usage,
    });
    transitionUtilityJob(runDir, jobId, "completed", { result });
    await dispatchBridgeMessage(
      runDir,
      "utility",
      claimed.request.requester,
      `Worker result ${jobId}: ${result.summary}`,
      undefined,
      undefined,
      {
        artifactRefs: result.artifactRefs.map((artifact) => artifact.path),
        taskId: jobId,
        type: "handover",
      }
    );
  } catch (error) {
    const current = readUtilityJob(runDir, jobId);
    if (
      current?.state === "completed" ||
      current?.state === "failed" ||
      current?.state === "escalated" ||
      current?.state === "canceled"
    ) {
      return;
    }
    appendJsonl(usageFile, {
      at: new Date().toISOString(),
      ...progress,
      jobId,
      model: config.model,
      providerSort: config.providerSort,
      status: "failed",
    });
    const summary = error instanceof Error ? error.message : String(error);
    const result: UtilityCompactResult = {
      artifactRefs: [],
      blocker: summary.slice(0, 1000),
      checks: [],
      filesChanged: [],
      status: "failed",
      summary: "Worker failed closed.",
    };
    transitionUtilityJob(runDir, jobId, "failed", { result });
    await dispatchBridgeMessage(
      runDir,
      "utility",
      claimed.request.requester,
      `Worker result ${jobId} failed: ${result.blocker}`,
      undefined,
      undefined,
      { taskId: jobId, type: "escalation" }
    );
  }
};

export const applyUtilityJobPatch = async (
  runDir: string,
  jobId: string,
  expectedPatchSha256: string,
  appliedBy: Agent
): Promise<GuardedPatchApplyResult> => {
  const job = readUtilityJob(runDir, jobId);
  if (!job) {
    throw new Error("unknown worker task_id");
  }
  if (
    job.state !== "completed" ||
    job.result?.status !== "completed" ||
    job.request.kind !== "edit"
  ) {
    throw new Error("guarded patch apply requires a completed worker edit");
  }
  const expected = expectedPatchSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("expected_patch_sha256 must be a SHA-256 hex digest");
  }
  const artifacts = job.result.artifactRefs.filter(
    (artifact) =>
      artifact.kind === "diff" &&
      artifact.path.endsWith(".patch") &&
      artifact.sha256?.toLowerCase() === expected
  );
  if (artifacts.length !== 1) {
    throw new Error(
      "expected patch artifact is missing or ambiguous for this worker job"
    );
  }
  const patchPath = artifacts[0]?.path;
  const manifestPath = artifacts[0]?.manifestPath;
  const manifestSha256 = artifacts[0]?.manifestSha256;
  if (!(patchPath && manifestPath && manifestSha256)) {
    throw new Error("worker patch or manifest integrity metadata is missing");
  }
  const repoRoot = repoRootForRun(runDir);
  const workspace = job.decision?.workspace
    ? verifyAdoptedUtilityWorkspace(repoRoot, job.decision.workspace)
    : undefined;
  if (job.decision?.workspace && !workspace) {
    throw new Error(
      "verified worker workspace no longer matches the run repository"
    );
  }
  const executionRoot = workspace?.root ?? repoRoot;
  const readScopes = workspace?.readScope ?? job.request.readScope;
  const writeScopes = workspace?.writeScope ?? job.request.writeScope;
  const broker = await createUtilityToolBroker({
    artifactDir: artifactDirForJob(executionRoot, runDir, jobId),
    commandAllowlist: [],
    readScopes: [...new Set([...readScopes, ...writeScopes])],
    repoRoot: executionRoot,
    writeScopes,
  });
  const result = await broker.applyPatchProposal({
    appliedBy,
    ...(job.application ? { existingApplication: job.application } : {}),
    expectedManifestSha256: manifestSha256,
    expectedPatchSha256: expected,
    manifestPath,
    patchPath,
  });
  if (result.status === "applied") {
    recordUtilityPatchApplication(runDir, jobId, result.application);
  }
  return result;
};

export const utilityJobStatus = (runDir: string, jobId: string) =>
  readUtilityJob(runDir, jobId);

const PANE_ANSI = {
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
};

const compactDisplayPath = (value: string): string => {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) || value;
};

const SLICE_OBJECTIVE_RE =
  /^Inspect (.+?) for the requested bounded source slice \((\d+)-(\d+)\) and return concise relevant evidence\.?$/i;
const START_OBJECTIVE_RE =
  /^Inspect (.+?) starting at line (\d+) for up to (\d+) lines and return only the evidence needed by the requester\.?$/i;

const paneRequestText = (value: string): string => {
  const clean = sanitizeUtilityPaneText(value);
  const slice = clean.match(SLICE_OBJECTIVE_RE);
  if (slice) {
    return `read ${compactDisplayPath(slice[1] ?? "")} lines ${slice[2]}–${slice[3]}`;
  }
  const start = clean.match(START_OBJECTIVE_RE);
  if (start) {
    const first = Number.parseInt(start[2] ?? "", 10);
    const count = Number.parseInt(start[3] ?? "", 10);
    const last = Number.isFinite(first + count) ? first + count - 1 : first;
    return `read ${compactDisplayPath(start[1] ?? "")} lines ${first}–${last}`;
  }
  return clean;
};

const MARKDOWN_NOISE_RE = /(?:\*\*|__|`|^#+\s*)/g;
const PIPE_SEPARATOR_RE = /\s*\|\s*/g;
const RESULT_PREFIX_RE = /^(?:Outcome|Result|Finding)\s*:\s*/i;
const COMPACT_READ_PREFIX_RE = /^read\s+/i;
const COMPACT_LINES_RE = /\s+lines\s+/i;

const paneResultText = (value: string): string => {
  const clean = sanitizeUtilityPaneText(value)
    .replace(MARKDOWN_NOISE_RE, "")
    .replaceAll(PIPE_SEPARATOR_RE, " · ");
  return clean.replace(RESULT_PREFIX_RE, "");
};

export interface UtilityPaneViewport {
  columns?: number;
  rows?: number;
}

const positiveViewportValue = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const paneWidth = (
  env: NodeJS.ProcessEnv,
  viewport: UtilityPaneViewport
): number =>
  Math.max(1, positiveViewportValue(viewport.columns ?? env.COLUMNS) ?? 80);

const paneRows = (
  env: NodeJS.ProcessEnv,
  viewport: UtilityPaneViewport
): number =>
  Math.max(1, positiveViewportValue(viewport.rows ?? env.LINES) ?? 20);

const fitPaneLine = (value: string, width: number): string => {
  const clean = sanitizeUtilityPaneText(value);
  if (clean.length <= width) {
    return clean;
  }
  return width <= 3 ? ".".repeat(width) : `${clean.slice(0, width - 3)}...`;
};

const colorPaneLine = (color: string, value: string, width: number): string =>
  `${color}${fitPaneLine(value, width)}${PANE_ANSI.reset}`;

const wrapPaneText = (
  value: string,
  width: number,
  maxLines: number
): string[] => {
  let remaining = sanitizeUtilityPaneText(value);
  const lines: string[] = [];
  while (remaining && lines.length < maxLines) {
    if (remaining.length <= width) {
      lines.push(remaining);
      break;
    }
    if (lines.length === maxLines - 1) {
      lines.push(fitPaneLine(remaining, width));
      break;
    }
    const candidate = remaining.slice(0, width + 1);
    const breakAt = Math.max(candidate.lastIndexOf(" "), 1);
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
};

const transcriptTime = (at: string): string => {
  const match = at.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? "--:--:--";
};

const renderTranscriptEntry = (
  entry: UtilityTranscriptEntry,
  width: number
): string[] => {
  const head = `${transcriptTime(entry.at)} ${entry.label} ${entry.jobId.slice(0, 8)}`;
  if (entry.kind === "tool") {
    return [
      colorPaneLine(PANE_ANSI.blue, `${head} · ${entry.text || "—"}`, width),
    ];
  }
  if (entry.kind === "request") {
    return [
      colorPaneLine(PANE_ANSI.cyan, head, width),
      ...wrapPaneText(
        paneRequestText(entry.text || "—"),
        Math.max(1, width - 2),
        1
      ).map((line) => colorPaneLine(PANE_ANSI.dim, `  ${line}`, width)),
    ];
  }
  const color = entry.label.includes("FAIL") ? PANE_ANSI.red : PANE_ANSI.green;
  return [
    colorPaneLine(color, head, width),
    ...wrapPaneText(
      paneResultText(entry.text || "—"),
      Math.max(1, width - 2),
      3
    ).map((line) => colorPaneLine(color, `  ${line}`, width)),
  ];
};

const compactRequestText = (entry: UtilityTranscriptEntry): string =>
  paneRequestText(entry.text || "—")
    .replace(COMPACT_READ_PREFIX_RE, "")
    .replace(COMPACT_LINES_RE, " ");

const renderCompactTranscriptJob = (
  entries: UtilityTranscriptEntry[],
  width: number,
  maxRows: number
): string[] => {
  const request = entries.find((entry) => entry.kind === "request");
  const tool = entries.findLast((entry) => entry.kind === "tool");
  const response = entries.findLast((entry) => entry.kind === "response");
  const lines: string[] = [];
  if (request) {
    lines.push(
      colorPaneLine(
        PANE_ANSI.cyan,
        `${transcriptTime(request.at)} ${request.label} ${request.jobId.slice(0, 8)} · ${compactRequestText(request)}`,
        width
      )
    );
  }
  if (tool && lines.length < maxRows) {
    lines.push(
      colorPaneLine(
        PANE_ANSI.blue,
        `${transcriptTime(tool.at)} ${tool.label} · ${tool.text || "—"}`,
        width
      )
    );
  }
  if (response && lines.length < maxRows) {
    const color = response.label.includes("FAIL")
      ? PANE_ANSI.red
      : PANE_ANSI.green;
    lines.push(
      colorPaneLine(
        color,
        `${transcriptTime(response.at)} ${response.label} ${response.jobId.slice(0, 8)}`,
        width
      )
    );
    const detailRows = Math.max(0, maxRows - lines.length);
    lines.push(
      ...wrapPaneText(
        paneResultText(response.text || "—"),
        width,
        detailRows
      ).map((line) => colorPaneLine(color, line, width))
    );
  }
  return lines.slice(0, maxRows);
};

const renderUtilityTranscript = (
  snapshot: UtilityObservabilitySnapshot,
  width: number,
  maxRows: number
): string[] => {
  if (maxRows <= 0) {
    return [];
  }
  if (snapshot.transcript.length === 0) {
    return [colorPaneLine(PANE_ANSI.dim, "waiting for first request", width)];
  }
  const byJob = new Map<string, UtilityTranscriptEntry[]>();
  for (const entry of snapshot.transcript) {
    const current = byJob.get(entry.jobId) ?? [];
    current.push(entry);
    byJob.set(entry.jobId, current);
  }
  const recentJobs = [...byJob.values()].sort((left, right) => {
    const leftAt = left.at(-1)?.at ?? "";
    const rightAt = right.at(-1)?.at ?? "";
    return rightAt.localeCompare(leftAt);
  });
  const groups: string[][] = [];
  let rows = 0;
  for (const entries of recentJobs) {
    const rendered = entries.flatMap((entry) =>
      renderTranscriptEntry(entry, width)
    );
    if (rows + rendered.length > maxRows) {
      continue;
    }
    groups.unshift(rendered);
    rows += rendered.length;
    if (rows >= maxRows) {
      break;
    }
  }
  if (groups.length === 0 && recentJobs[0]) {
    return renderCompactTranscriptJob(recentJobs[0], width, maxRows);
  }
  return groups.flat();
};

export const renderUtilityPane = (
  runDir: string,
  env: NodeJS.ProcessEnv = process.env,
  viewport: UtilityPaneViewport = {}
): string => {
  const snapshot = readUtilityObservability(runDir);
  const width = paneWidth(env, viewport);
  const maxRows = paneRows(env, viewport);
  return renderUtilityTranscript(snapshot, width, maxRows)
    .slice(0, maxRows)
    .join("\n");
};

export const runUtilityPane = async (
  runDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  for (;;) {
    process.stdout.write(
      `\u001b[2J\u001b[H${renderUtilityPane(runDir, env, {
        columns: process.stdout.columns,
        rows: process.stdout.rows,
      })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn } from "bun";
import { dispatchBridgeMessage } from "./bridge-dispatch";
import { readDelegationEvents } from "./delegation-policy";
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
  readUtilityObservability,
  sanitizeUtilityPaneText,
  type UtilityObservabilitySnapshot,
  type UtilityTranscriptEntry,
} from "./utility-observability";
import {
  routeUtilityRequest,
  type UtilityCheckResult,
  type UtilityCompactResult,
  type UtilityRouteRequest,
  type UtilityRoutingPolicy,
  type UtilityTier,
  type UtilityTierSelectionStrategy,
} from "./task-router";
import type { Agent } from "./types";
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
  type UtilityToolName,
  type UtilityToolResult,
} from "./utility-tools";

export const UTILITY_WORKER_SUBCOMMAND = "__utility-worker";
export const UTILITY_PANE_SUBCOMMAND = "__utility-pane";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "z-ai/glm-5.2";
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_API_KEY_FILE = join(
  homedir(),
  ".config",
  "loop",
  "openrouter.key"
);

export interface UtilityRuntimeConfig {
  allowedTierPatterns: string[];
  apiKey?: string;
  availability: UtilityAvailability;
  costQualityTradeoff: number;
  defaultFallbackTierId: string;
  enabled: boolean;
  endpoint: string;
  maxClaimWaitMs: number;
  maxJobCostUsd: number;
  maxJobRuntimeMs: number;
  maxRunCostUsd: number;
  maxSteps: number;
  maxTokens: number;
  maxTotalTokens: number;
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
    maxJobCostUsd: positiveNumber(env.LOOP_UTILITY_MAX_JOB_USD, 0.05),
    maxClaimWaitMs: positiveNumber(env.LOOP_UTILITY_MAX_CLAIM_WAIT_MS, 30_000),
    maxJobRuntimeMs: positiveNumber(env.LOOP_UTILITY_MAX_RUNTIME_MS, 900_000),
    maxRunCostUsd: positiveNumber(env.LOOP_UTILITY_MAX_RUN_USD, 0.25),
    maxSteps: Math.floor(
      positiveNumber(env.LOOP_UTILITY_MAX_STEPS, DEFAULT_MAX_STEPS)
    ),
    maxTokens: Math.floor(positiveNumber(env.LOOP_UTILITY_MAX_TOKENS, 1800)),
    maxTotalTokens: Math.floor(
      positiveNumber(env.LOOP_UTILITY_MAX_TOTAL_TOKENS, 8000)
    ),
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
  maxJobCostUsd: config.maxJobCostUsd,
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
  target: "utility" | "driver" | "peer" | "escalate"
): "routed-utility" | "routed-driver" | "routed-peer" | "escalated" => {
  if (target === "utility") {
    return "routed-utility";
  }
  if (target === "peer") {
    return "routed-peer";
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
        summary: "Utility worker was fenced and failed closed.",
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
    `Utility result ${job.jobId} failed: ${reason}`,
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
    return "utility claim belongs to a stale governess epoch";
  }
  if (input.deadWorker) {
    return "utility worker process is no longer alive";
  }
  return input.claimTimedOut
    ? "utility worker did not claim the routed job"
    : input.runTimedOut
      ? "utility job exceeded its runtime limit and was terminated"
      : "utility worker failed closed";
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

const currentUtilityWriteClaims = (runDir: string): string[] =>
  readUtilityJobs(runDir)
    .filter((active) =>
      ["routed-utility", "claimed", "running"].includes(active.state)
    )
    .flatMap((active) => active.request.writeScope);

const readJsonlRecords = (path: string): Record<string, unknown>[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return parsed && typeof parsed === "object"
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

const recordedUtilityCostUsd = (runDir: string): number => {
  const latestByJob = new Map<string, number>();
  for (const event of readJsonlRecords(
    join(runDir, "utility", "usage.jsonl")
  )) {
    const jobId = typeof event.jobId === "string" ? event.jobId : undefined;
    const usage =
      event.usage && typeof event.usage === "object"
        ? (event.usage as Record<string, unknown>)
        : undefined;
    const cost = usage?.cost;
    if (
      jobId &&
      typeof cost === "number" &&
      Number.isFinite(cost) &&
      cost >= 0
    ) {
      latestByJob.set(jobId, cost);
    }
  }
  return [...latestByJob.values()].reduce((total, cost) => total + cost, 0);
};

const requestReservationUsd = (
  request: UtilityRouteRequest,
  maxJobCostUsd: number
): number => {
  const estimated = request.estimatedCostUsd;
  return typeof estimated === "number" &&
    Number.isFinite(estimated) &&
    estimated >= 0
    ? estimated
    : maxJobCostUsd;
};

const activeUtilityReservationUsd = (
  runDir: string,
  maxJobCostUsd: number
): number =>
  readUtilityJobs(runDir)
    .filter((job) =>
      ["routed-utility", "claimed", "running"].includes(job.state)
    )
    .reduce(
      (total, job) => total + requestReservationUsd(job.request, maxJobCostUsd),
      0
    );

const remainingUtilityRunBudgetUsd = (
  runDir: string,
  config: UtilityRuntimeConfig
): number =>
  Math.max(
    0,
    config.maxRunCostUsd -
      recordedUtilityCostUsd(runDir) -
      activeUtilityReservationUsd(runDir, config.maxJobCostUsd)
  );

const startRoutedUtilityJob = async (input: {
  context: UtilityQueueContext;
  deps: UtilityQueueDependencies;
  env: NodeJS.ProcessEnv;
  job: UtilityJobSnapshot;
}): Promise<void> => {
  let started = false;
  try {
    started = (input.deps.spawnWorker ?? spawnUtilityWorker)({
      env: input.env,
      epoch: input.context.epoch,
      jobId: input.job.jobId,
      repoRoot: input.context.repoRoot,
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
      "utility worker process failed to start"
    );
  }
};

const dispatchNonUtilityRoute = async (
  context: UtilityQueueContext,
  job: UtilityJobSnapshot,
  target: "driver" | "peer" | "escalate",
  reason: string
): Promise<void> => {
  const requesterPeer =
    job.request.requester === context.currentDriver
      ? context.peer
      : context.currentDriver;
  await dispatchBridgeMessage(
    context.runDir,
    "utility",
    target === "peer" ? requesterPeer : context.currentDriver,
    `Utility route ${job.jobId} returned to ${target}: ${reason}. Objective: ${job.request.objective}`,
    undefined,
    undefined,
    {
      taskId: job.jobId,
      type: target === "escalate" ? "escalation" : "work_request",
    }
  );
};

const processPendingUtilityJob = async (input: {
  config: UtilityRuntimeConfig;
  context: UtilityQueueContext;
  deps: UtilityQueueDependencies;
  env: NodeJS.ProcessEnv;
  job: UtilityJobSnapshot;
}): Promise<void> => {
  const routedDecision = routeUtilityRequest(input.job.request, {
    activeWriteClaims: currentUtilityWriteClaims(input.context.runDir),
    currentDriver: input.context.currentDriver,
    currentEpoch: input.context.epoch,
    peer: input.context.peer,
    remainingRunBudgetUsd: remainingUtilityRunBudgetUsd(
      input.context.runDir,
      input.config
    ),
    routingPolicy: routingPolicy(input.config),
    tiers: [runtimeTier(input.config)],
  });
  const decision =
    routedDecision.reason === "utility-unavailable"
      ? { ...routedDecision, detail: input.config.availability.message }
      : routedDecision;
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
    await startRoutedUtilityJob(input);
    return;
  }
  await dispatchNonUtilityRoute(
    input.context,
    input.job,
    decision.target,
    decision.detail
      ? `${decision.reason} (${decision.detail})`
      : decision.reason
  );
};

export const processPendingUtilityRoutes = async (
  context: UtilityQueueContext,
  env: NodeJS.ProcessEnv = process.env,
  deps: UtilityQueueDependencies = {}
): Promise<number> => {
  const workerEnv = buildUtilityWorkerEnvironment(env);
  const config = resolveUtilityRuntimeConfig(workerEnv);
  if (!activateUtilityEpoch(context.runDir, context.epoch)) {
    throw new Error("stale governess epoch cannot activate utility routing");
  }
  await recoverStaleUtilityJobs(context, config, deps);
  const pending = readPendingRouteRequests(context.runDir);
  for (const job of pending) {
    await processPendingUtilityJob({
      config,
      context,
      deps,
      env: workerEnv,
      job,
    });
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
    "You are the bounded utility worker beneath two main coding agents.",
    "Do only the declared objective and acceptance criteria. Use tools for evidence.",
    "Never expand scope, access secrets, change dependencies, make product decisions, or perform remote/destructive actions.",
    "For edits, produce a minimal unified diff with propose_patch; it is reviewed/applied by a main agent.",
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
        "utility edit completed without a validated patch artifact"
      );
    }
    return;
  }
  if (request.kind === "command") {
    if (!successfulTools.has("run_check")) {
      throw new Error(
        "utility command completed without a successful focused check"
      );
    }
    return;
  }
  if (successfulTools.size === 0) {
    throw new Error("utility task completed without repository tool evidence");
  }
};

const executeUtilityToolCall = async (input: {
  broker: Awaited<ReturnType<typeof createUtilityToolBroker>>;
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

const assertUtilityBudget = (
  usage: OpenAICompatibleUsage,
  config: UtilityRuntimeConfig
): void => {
  if (usage.totalTokens > config.maxTotalTokens) {
    throw new Error("utility job exceeded its total token limit");
  }
  if ((usage.cost ?? 0) > config.maxJobCostUsd) {
    throw new Error("utility job exceeded its cost limit");
  }
};

const runUtilityConversation = async (input: {
  broker: Awaited<ReturnType<typeof createUtilityToolBroker>>;
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
  let usage = emptyUsage();
  const progress = (): UtilityConversationProgress => ({
    durationMs: Math.max(0, Date.now() - startedAt),
    modelCalls,
    toolCalls,
    toolRounds,
    usage,
  });
  for (let step = 0; step < input.config.maxSteps; step += 1) {
    const response = await openAICompatibleChat({
      ...(input.config.apiKey ? { apiKey: input.config.apiKey } : {}),
      endpoint: input.config.endpoint,
      maxTokens: input.config.maxTokens,
      messages,
      model: input.config.model,
      onTrace: (event: OpenAICompatibleTraceEvent) =>
        appendJsonl(input.traceFile, { jobId: input.jobId, ...event }),
      ...(openRouterProvider(input.config)
        ? { provider: openRouterProvider(input.config) }
        : {}),
      temperature: 0.1,
      toolChoice: "auto",
      tools: input.broker.definitions,
    });
    modelCalls += 1;
    usage = addUsage(usage, response.usage);
    input.onProgress(progress());
    assertUtilityBudget(usage, input.config);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    messages.push(response.message);
    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      assertConversationEvidence(input.request, successfulTools, artifacts);
      return {
        artifacts,
        checks,
        ...progress(),
        summary: response.message.content?.trim() || "Utility task completed.",
      };
    }
    toolRounds += 1;
    for (const call of calls) {
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
      input.onProgress(progress());
      recordToolResult(name, result, artifacts, checks);
      messages.push({
        content: JSON.stringify(result),
        name,
        role: "tool",
        tool_call_id: call.id,
      });
    }
  }
  throw new Error("utility worker reached its step limit without completion");
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
  const broker = await createUtilityToolBroker({
    artifactDir: artifactDirForJob(repoRoot, runDir, jobId),
    readScopes: [
      ...new Set([...claimed.request.readScope, ...claimed.request.writeScope]),
    ],
    repoRoot,
    writeScopes: claimed.request.writeScope,
  });
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
      request: claimed.request,
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
      `Utility result ${jobId}: ${result.summary}`,
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
      summary: "Utility worker failed closed.",
    };
    transitionUtilityJob(runDir, jobId, "failed", { result });
    await dispatchBridgeMessage(
      runDir,
      "utility",
      claimed.request.requester,
      `Utility result ${jobId} failed: ${result.blocker}`,
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
    throw new Error("unknown utility task_id");
  }
  if (
    job.state !== "completed" ||
    job.result?.status !== "completed" ||
    job.request.kind !== "edit"
  ) {
    throw new Error("guarded patch apply requires a completed utility edit");
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
      "expected patch artifact is missing or ambiguous for this utility job"
    );
  }
  const patchPath = artifacts[0]?.path;
  const manifestPath = artifacts[0]?.manifestPath;
  const manifestSha256 = artifacts[0]?.manifestSha256;
  if (!(patchPath && manifestPath && manifestSha256)) {
    throw new Error("utility patch or manifest integrity metadata is missing");
  }
  const repoRoot = repoRootForRun(runDir);
  const broker = await createUtilityToolBroker({
    artifactDir: artifactDirForJob(repoRoot, runDir, jobId),
    commandAllowlist: [],
    readScopes: [
      ...new Set([...job.request.readScope, ...job.request.writeScope]),
    ],
    repoRoot,
    writeScopes: job.request.writeScope,
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

const formatPaneCost = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(value < 0.1 ? 4 : 3)}`
    : "$--";

const formatPaneNumber = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString("en-US")
    : "--";

const paneRouterRow = (
  runDir: string,
  snapshot: UtilityObservabilitySnapshot
): string => {
  const events = readDelegationEvents(runDir);
  const count = (disposition: string): number =>
    events.filter((event) => event.disposition === disposition).length;
  const route = (snapshot.latestRoute ?? "waiting").replace(
    "utility-eligible",
    "eligible"
  );
  const rawDetail = snapshot.latestRouteDetail ?? "";
  const usefulDetail = rawDetail.includes("chmod 600")
    ? "chmod 600 · key file permissions too open"
    : rawDetail;
  const detail = usefulDetail ? ` · ${usefulDetail}` : "";
  return `ROUTE ${route}${detail} · auto ${count("auto-routed")} · exp ${count("explicit-routed")} · miss ${count("missed-candidate")}`;
};

const paneWorkerState = (snapshot: UtilityObservabilitySnapshot): string => {
  if (snapshot.active > 0) {
    return "active";
  }
  return snapshot.queued > 0 ? "queued" : "idle";
};

const paneModel = (model: string): string => model.split("/").at(-1) ?? model;

const formatPaneDuration = (durationMs: number): string =>
  durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;

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
const EVIDENCE_MARKER_RE = /\bEvidence(?:\s*\([^)]*\))?\s*:\s*/i;
const PIPE_SEPARATOR_RE = /\s*\|\s*/g;
const EVIDENCE_TABLE_HEADER_RE =
  /^·\s*Lines\s*·\s*Content Summary\s*·\s*·\s*-+\s*·\s*-+\s*·\s*/i;
const LEADING_LIST_MARKER_RE = /^[-·]\s*/;
const REPEATED_MIDDLE_DOT_RE = /\s*·(?:\s*·)+\s*/g;
const RESULT_PREFIX_RE = /^(?:Outcome|Result|Finding)\s*:\s*/i;
const COMPACT_READ_PREFIX_RE = /^read\s+/i;
const COMPACT_LINES_RE = /\s+lines\s+/i;

const paneResultText = (value: string): string => {
  const clean = sanitizeUtilityPaneText(value)
    .replace(MARKDOWN_NOISE_RE, "")
    .replaceAll(PIPE_SEPARATOR_RE, " · ");
  const marker = clean.match(EVIDENCE_MARKER_RE);
  if (marker?.index !== undefined) {
    const evidence = clean.slice(marker.index + marker[0].length).trim();
    if (evidence) {
      return evidence
        .replace(EVIDENCE_TABLE_HEADER_RE, "")
        .replace(LEADING_LIST_MARKER_RE, "")
        .replace(REPEATED_MIDDLE_DOT_RE, " · ");
    }
  }
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
    return [fitPaneLine(`${head} · ${entry.text || "—"}`, width)];
  }
  if (entry.kind === "request") {
    return [
      fitPaneLine(head, width),
      ...wrapPaneText(
        paneRequestText(entry.text || "—"),
        Math.max(1, width - 2),
        1
      ).map((line) => `  ${line}`),
    ];
  }
  const usage = entry.usage;
  const metrics = usage
    ? [
        formatPaneDuration(usage.durationMs),
        `${formatPaneNumber(usage.modelCalls)}c/${formatPaneNumber(usage.toolCalls)}t`,
      ].join(" · ")
    : "no usage";
  const detail = [
    ...(usage
      ? [
          `${formatPaneNumber(usage.totalTokens)} tok`,
          formatPaneCost(usage.costUsd),
        ]
      : []),
    paneResultText(entry.text || "—"),
  ].join(" · ");
  return [
    fitPaneLine(`${head} · ${metrics}`, width),
    ...wrapPaneText(detail, Math.max(1, width - 2), 3).map(
      (line) => `  ${line}`
    ),
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
      fitPaneLine(
        `REQ ${request.jobId.slice(0, 8)} · ${compactRequestText(request)}`,
        width
      )
    );
  }
  if (tool && lines.length < maxRows) {
    lines.push(fitPaneLine(`TOOL ${tool.text || "—"}`, width));
  }
  if (response && lines.length < maxRows) {
    const usage = response.usage;
    const metrics = usage
      ? `${formatPaneDuration(usage.durationMs)} · ${formatPaneNumber(usage.modelCalls)}c/${formatPaneNumber(usage.toolCalls)}t · ${formatPaneNumber(usage.totalTokens)} tok · ${formatPaneCost(usage.costUsd)}`
      : "no usage";
    lines.push(
      fitPaneLine(
        `${response.label.replace("GLM ", "")} ${response.jobId.slice(0, 8)} · ${metrics}`,
        width
      )
    );
    const detailRows = Math.max(0, maxRows - lines.length);
    lines.push(
      ...wrapPaneText(paneResultText(response.text || "—"), width, detailRows)
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
    return ["  waiting for first request"];
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
  const config = resolveUtilityRuntimeConfig(
    buildUtilityWorkerEnvironment(env)
  );
  const snapshot = readUtilityObservability(runDir);
  const width = paneWidth(env, viewport);
  const maxRows = paneRows(env, viewport);
  const healthy = runtimeTier(config).healthy;
  const top = [
    `${paneModel(config.model).toUpperCase()} ${healthy ? "READY" : "OFFLINE"} · ${paneWorkerState(snapshot)} · jobs ${snapshot.jobsTotal} a${snapshot.active} q${snapshot.queued} d${snapshot.completed} f${snapshot.failed}`,
    `USAGE ${formatPaneNumber(snapshot.usage.modelCalls)} calls · ${formatPaneNumber(snapshot.usage.toolCalls)} tools · ${formatPaneNumber(snapshot.usage.totalTokens)} tok · ${formatPaneCost(snapshot.usage.costUsd)}`,
    `TOKENS in ${formatPaneNumber(snapshot.usage.inputTokens)} · cache ${formatPaneNumber(snapshot.usage.cachedInputTokens)} · out ${formatPaneNumber(snapshot.usage.outputTokens)}`,
    paneRouterRow(runDir, snapshot),
    "RECENT JOBS · request / tool / result",
  ].map((line) => fitPaneLine(line, width));
  return [
    ...top,
    ...renderUtilityTranscript(
      snapshot,
      width,
      Math.max(0, maxRows - top.length)
    ),
  ]
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

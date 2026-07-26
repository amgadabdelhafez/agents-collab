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
  transitionUtilityJob,
  type UtilityJobSnapshot,
} from "./utility-store";
import {
  createUtilityToolBroker,
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
  costQualityTradeoff: number;
  defaultFallbackTierId: string;
  enabled: boolean;
  endpoint: string;
  maxClaimWaitMs: number;
  maxJobCostUsd: number;
  maxJobRuntimeMs: number;
  maxSteps: number;
  maxTokens: number;
  maxTotalTokens: number;
  model: string;
  preventPerRequestOverrides: boolean;
  providerSort: UtilityTierSelectionStrategy;
}

export interface UtilityQueueContext {
  currentDriver: Agent;
  epoch: number;
  peer: Agent;
  repoRoot: string;
  runDir: string;
}

export interface UtilityQueueDependencies {
  spawnWorker?: (input: {
    env: NodeJS.ProcessEnv;
    epoch: number;
    jobId: string;
    repoRoot: string;
    runDir: string;
  }) => boolean;
}

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

const readUtilityApiKeyFile = (
  path: string | undefined
): string | undefined => {
  if (!path) {
    return undefined;
  }
  try {
    if (statSync(path).mode % 0o100 !== 0) {
      return undefined;
    }
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

const utilityApiKey = (env: NodeJS.ProcessEnv): string | undefined => {
  const direct =
    env.OPENROUTER_API_KEY?.trim() || env.LOOP_UTILITY_API_KEY?.trim();
  if (direct) {
    return direct;
  }
  const configuredPath = env.LOOP_UTILITY_API_KEY_FILE;
  const keyFile =
    configuredPath === ""
      ? undefined
      : configuredPath?.trim() || DEFAULT_API_KEY_FILE;
  return readUtilityApiKeyFile(keyFile);
};

export const resolveUtilityRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): UtilityRuntimeConfig => {
  const endpoint = env.LOOP_UTILITY_URL?.trim() || DEFAULT_ENDPOINT;
  const apiKey = utilityApiKey(env);
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
    costQualityTradeoff: boundedTradeoff(env.LOOP_UTILITY_COST_QUALITY),
    defaultFallbackTierId:
      env.LOOP_UTILITY_FALLBACK_TIER?.trim() || "utility-default",
    enabled,
    endpoint,
    maxJobCostUsd: positiveNumber(env.LOOP_UTILITY_MAX_JOB_USD, 0.05),
    maxClaimWaitMs: positiveNumber(env.LOOP_UTILITY_MAX_CLAIM_WAIT_MS, 30_000),
    maxJobRuntimeMs: positiveNumber(env.LOOP_UTILITY_MAX_RUNTIME_MS, 900_000),
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
  staleEpoch: boolean;
}): string => {
  if (input.staleEpoch) {
    return "utility claim belongs to a stale governess epoch";
  }
  return input.claimTimedOut
    ? "utility worker did not claim the routed job"
    : "utility job exceeded its runtime limit";
};

const recoverStaleUtilityJobs = async (
  context: UtilityQueueContext,
  config: UtilityRuntimeConfig
): Promise<void> => {
  const now = Date.now();
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
    if (staleEpoch || claimTimedOut || runTimedOut) {
      await failUtilityJob(
        context,
        active,
        staleUtilityReason({ claimTimedOut, staleEpoch })
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
  const decision = routeUtilityRequest(input.job.request, {
    activeWriteClaims: currentUtilityWriteClaims(input.context.runDir),
    currentDriver: input.context.currentDriver,
    currentEpoch: input.context.epoch,
    peer: input.context.peer,
    routingPolicy: routingPolicy(input.config),
    tiers: [runtimeTier(input.config)],
  });
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
    decision.reason
  );
};

export const processPendingUtilityRoutes = async (
  context: UtilityQueueContext,
  env: NodeJS.ProcessEnv = process.env,
  deps: UtilityQueueDependencies = {}
): Promise<number> => {
  const config = resolveUtilityRuntimeConfig(env);
  if (!activateUtilityEpoch(context.runDir, context.epoch)) {
    throw new Error("stale governess epoch cannot activate utility routing");
  }
  await recoverStaleUtilityJobs(context, config);
  const pending = readPendingRouteRequests(context.runDir);
  for (const job of pending) {
    await processPendingUtilityJob({ config, context, deps, env, job });
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
        path: artifact.path,
        sha256: artifact.sha256,
      })),
      checks: conversation.checks,
      filesChanged: [],
      status: "completed",
      summary: conversation.summary.slice(0, 4000),
    };
    transitionUtilityJob(runDir, jobId, "completed", { result });
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

export const utilityJobStatus = (runDir: string, jobId: string) =>
  readUtilityJob(runDir, jobId);

const compactObjective = (value: string): string => {
  const oneLine = value.replaceAll(/\s+/g, " ").trim();
  return oneLine.length > 44 ? `${oneLine.slice(0, 41)}...` : oneLine;
};

const readPaneEvents = (path: string): Record<string, unknown>[] => {
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

const formatPaneCost = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(value < 0.01 ? 4 : 3)}`
    : "$--";

const formatPaneNumber = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString("en-US")
    : "--";

const paneToolRow = (runDir: string): string => {
  const event = readPaneEvents(join(runDir, "utility", "tool-events.jsonl")).at(
    -1
  );
  if (!event) {
    return "TOOL  waiting for first bounded tool call";
  }
  const tool = typeof event.tool === "string" ? event.tool : "unknown";
  const ok = event.ok === true ? "ok" : "failed";
  const duration = formatPaneNumber(event.durationMs);
  return `TOOL  ${tool}  ${ok}  ${duration}ms`;
};

const paneUsageRow = (runDir: string): string => {
  const event = readPaneEvents(join(runDir, "utility", "usage.jsonl")).at(-1);
  if (!event) {
    return "LAST  no completed worker call yet";
  }
  const usage =
    event.usage && typeof event.usage === "object"
      ? (event.usage as Record<string, unknown>)
      : {};
  const status = typeof event.status === "string" ? event.status : "unknown";
  return `LAST  ${status}  ${formatPaneNumber(usage.totalTokens)} tok  ${formatPaneCost(usage.cost)}`;
};

export const renderUtilityPane = (
  runDir: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const config = resolveUtilityRuntimeConfig(env);
  const jobs = readUtilityJobs(runDir).reverse();
  const current = jobs.find((job) =>
    ["running", "claimed", "routed-utility", "pending-route"].includes(
      job.state
    )
  );
  const active = jobs.filter((job) =>
    ["running", "claimed"].includes(job.state)
  ).length;
  const queued = jobs.filter((job) =>
    ["pending-route", "routed-utility"].includes(job.state)
  ).length;
  const completed = jobs.filter((job) => job.state === "completed").length;
  const failed = jobs.filter((job) =>
    ["failed", "escalated", "canceled"].includes(job.state)
  ).length;
  const recent = jobs
    .slice(0, 2)
    .map(
      (job) =>
        `${job.jobId.slice(0, 8)}  ${job.state.padEnd(15)}  ${compactObjective(job.request.objective)}`
    );
  return [
    `LOWER AGENT  ${config.model}  ${config.enabled ? "READY" : "OFFLINE"}`,
    `STATUS  active=${active} queued=${queued} done=${completed} failed=${failed}`,
    current
      ? `NOW  ${current.jobId.slice(0, 8)} ${current.state}  ${compactObjective(current.request.objective)}`
      : "NOW  idle; waiting for governess routing",
    paneToolRow(runDir),
    paneUsageRow(runDir),
    "governess routes; observer pane is read-only",
    ...(recent.length > 0 ? recent : ["No utility jobs yet."]),
  ].join("\n");
};

export const runUtilityPane = async (
  runDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  for (;;) {
    process.stdout.write(
      `\u001b[2J\u001b[H${renderUtilityPane(runDir, env)}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

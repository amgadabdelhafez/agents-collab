export type Agent = "claude" | "codex" | "gemini" | "cursor" | "copilot";
export type CavemanMode = "off" | "lite" | "full" | "ultra";
export type CavemanModeSource = "cli" | "default" | "env" | "manifest";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type EffortSource =
  | "cli-global"
  | "cli-role"
  | "default"
  | "env-global"
  | "env-role"
  | "manifest";
export type Format = "pretty" | "raw";
export type ReviewMode = Agent | "claudex";
export type PlanReviewMode = Agent | "other" | "none";
export type ReviewStatus = "pass" | "fail";
export type RunLifecycleState =
  | "submitted"
  | "working"
  | "reviewing"
  | "input-required"
  | "completed"
  | "failed"
  | "stopped";
export type RunStatus = "running" | "done" | "failed" | "stopped";
export interface PairedSessionIds {
  claude?: string;
  codex?: string;
  copilot?: string;
  cursor?: string;
  gemini?: string;
}
export interface LaunchWorkspaceBinding {
  branchRef?: string;
  repoId: string;
  root: string;
}
export type ValueFlag =
  | "agent"
  | "prompt"
  | "max"
  | "done"
  | "proof"
  | "pairWith"
  | "effort"
  | "driverEffort"
  | "reviewerEffort"
  | "codexModel"
  | "codexReviewerModel"
  | "copilotModel"
  | "copilotReviewerModel"
  | "cursorModel"
  | "cursorReviewerModel"
  | "claudeReviewerModel"
  | "geminiModel"
  | "geminiReviewerModel"
  | "format"
  | "runId"
  | "session"
  | "workspace"
  | "governessIdle"
  | "governessCooldown"
  | "governessMaxRecoveries"
  | "governessUrl"
  | "governessModel"
  | "governessHeight"
  | "cavemanMode"
  | "helperCavemanMode";

export type GovernessAgentState =
  | "working"
  | "waiting-human"
  | "waiting-peer"
  | "limited"
  | "stuck"
  | "crashed";

export interface GovernessVerdict {
  confidence: number;
  state: GovernessAgentState;
  suggestedAction?: string;
  summary: string;
}

// One normalized hook event, appended as a JSONL line by both agents' hooks.
export interface HookEvent {
  agent: Agent;
  cwd?: string;
  detail?: string;
  // True when the payload indicates a failed tool call / error.
  error?: boolean;
  event: string;
  // Stable event identity and per-agent order are authored by the hook
  // process, not inferred from terminal prose by the governess.
  eventId?: string;
  sequence?: number;
  source?: "agent-hook" | "codex-app-server" | "tmux-fallback";
  state?:
    | "starting"
    | "working"
    | "input-required"
    | "waiting-peer"
    | "blocked"
    | "draining"
    | "handover-ready"
    | "exited"
    | "failed"
    | "canceled";
  tool?: string;
  ts: string;
}

// --- Detector (governess-detect.ts) ---
// Per-agent input for one detector tick.
export interface AgentLivenessInput {
  agent: Agent;
  lastEventTs?: string;
  paneHash: string;
}

// Detector state carried across ticks for one agent.
export interface AgentLivenessState {
  agent: Agent;
  lastEventTs?: string;
  paneHash: string;
  paneStableSinceMs: number;
}

// Detector verdict for one agent on one tick.
export interface AgentLiveness {
  agent: Agent;
  lastEventAgeMs: number;
  // Time since the pane last changed. Small = the TUI is animating (the agent
  // is actively thinking/working); large = the pane is frozen (truly idle).
  paneIdleMs: number;
  paneStable: boolean;
  suspect: boolean;
}

// --- Recovery ladder (governess-recover.ts) ---
export type RecoveryLevel = "answer-prompt" | "nudge" | "restart";

export interface RecoveryHistoryEntry {
  agent: Agent;
  level: RecoveryLevel;
  ts: string;
}

export interface RecoveryDecision {
  agent: Agent;
  level: RecoveryLevel | null;
  reason: string;
}

// --- Usage / cost (governess-usage.ts) ---
// Per-agent token/context/cost snapshot derived from the agent's session
// transcript. All token counts are cumulative for the session.
export type UsageDataConfidence = "approx" | "error" | "exact" | "missing";

export type UsageLimitKind = "account" | "session" | "weekly";

export interface UsageLimitWindow {
  kind: UsageLimitKind;
  label: string;
  model?: string;
  reset?: string;
  resetAtMs?: number;
  scopeKind?: string;
  usedPct: number;
}

export interface AgentUsage {
  // Provider-labeled automatic compactions when the transcript distinguishes
  // them. Undefined means the provider did not expose a trigger kind.
  automaticCompactions?: number;
  // Claude cache-write total; cacheCreate1hTokens is the 1-hour subset.
  cacheCreate1hTokens?: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  compactedContextTokens: number;
  compactions: number;
  contextRateTokensPerMinute: number;
  contextTokens: number;
  contextWindow: number;
  // Estimated replacement value from the Usage Tracker pricing catalog.
  costEstimateBasis?: "api-usd" | "credit-estimate";
  costEstimateCoveragePct?: number;
  costRateUsdPerHour: number;
  costUsd: number;
  // ChatGPT/Codex credit multiplier relative to standard mode when known.
  creditCostMultiplier?: number;
  dataConfidence: UsageDataConfidence;
  estimatedCredits?: number;
  firstTs?: string;
  // Count of genuine human prompts seen in this agent's transcript.
  humanMessages: number;
  inputTokens: number;
  lastCompactionTs?: string;
  lastTs?: string;
  // Count of this agent's own (assistant) messages.
  messages: number;
  model?: string;
  outputTokens: number;
  rateLimitPrimaryPct?: number;
  rateLimitPrimaryReset?: string;
  rateLimitSecondaryPct?: number;
  rateLimitSecondaryReset?: string;
  rateLimitWindows?: UsageLimitWindow[];
  reasoningEffort?: string;
  serviceTier?: string;
  speed?: string;
  textMessages: number;
  thinkingMessages: number;
  toolCallCounts: Record<string, number>;
  toolCalls: number;
  totalTokens: number;
}

// --- LLM judge (governess-llm.ts) ---
export interface JudgeRequest {
  agent: Agent;
  hookTail: HookEvent[];
  model: string;
  paneText: string;
  traceFile?: string;
  url: string;
}

export type JudgeFailureReason = "malformed" | "timeout" | "unreachable";

export interface LocalLlmUsage {
  cachedInputTokens: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type JudgeOutcome =
  | {
      ok: true;
      tokens?: number;
      usage?: LocalLlmUsage;
      verdict: GovernessVerdict;
    }
  | {
      fallback: GovernessVerdict;
      ok: false;
      reason: JudgeFailureReason;
      tokens?: number;
      usage?: LocalLlmUsage;
    };

// Local-LLM session summary (a few lines describing the session + progress).
export interface SummaryAgentContext {
  agent: Agent;
  lastActions: string[];
  paneText: string;
}

export interface SummaryRequest {
  agents: SummaryAgentContext[];
  // Deterministic objective derived from current-session human instructions.
  authoritativeObjective?: string;
  // Human instructions given during the session (verbatim, most recent last).
  humanMessages?: string[];
  model: string;
  // Prior-session summaries, newest first, for cross-session continuity.
  priorSummaries?: string[];
  // Project docs (CLAUDE.md / AGENTS.md / PLAN.md excerpts) from the run cwd.
  projectContext?: string;
  traceFile?: string;
  url: string;
}

export interface SummaryResult {
  text: string;
  tokens: number;
  usage?: LocalLlmUsage;
}

// Local-LLM per-agent pane label (a short task noun phrase for the pane border).
export interface PaneLabelRequest {
  agents: SummaryAgentContext[];
  model: string;
  traceFile?: string;
  url: string;
}

export interface PaneLabelResult {
  // Short task label per agent, e.g. { claude: "auth refactor" }. Empty on failure.
  labels: Partial<Record<Agent, string>>;
  tokens: number;
  usage?: LocalLlmUsage;
}

// Local-LLM judgment of whether both idle agents are blocked on the human.
export interface WaitingRequest {
  agents: SummaryAgentContext[];
  model: string;
  traceFile?: string;
  url: string;
}

export interface WaitingResult {
  // One-line description of what the agents need from the human ("" if none).
  ask: string;
  tokens: number;
  usage?: LocalLlmUsage;
  waiting: boolean;
}

export interface RoleBalanceAgentContext {
  agent: Agent;
  contextPct: number;
  currentDriver: boolean;
  recentAction?: string;
  sessionPct?: number;
  sessionReset?: string;
  state: string;
  weeklyPct?: number;
  weeklyReset?: string;
}

export interface RoleBalanceRequest {
  agents: RoleBalanceAgentContext[];
  candidateDriver?: Agent;
  currentDriver?: Agent;
  initialDriver?: Agent;
  model: string;
  reasonHint?: string;
  summary?: string;
  traceFile?: string;
  url: string;
}

export interface RoleBalanceResult {
  confidence: number;
  driver?: Agent;
  reason: string;
  switchDriver: boolean;
  tokens: number;
  usage?: LocalLlmUsage;
}

export interface Options {
  agent: Agent;
  cavemanMode: CavemanMode;
  cavemanModeSource: CavemanModeSource;
  claudeMcpConfigPath?: string;
  claudePersistentSession?: boolean;
  claudeReviewerModel?: string;
  codexHome?: string;
  codexMcpConfigArgs?: string[];
  codexModel: string;
  codexReviewerModel?: string;
  copilotMcpConfigPath?: string;
  copilotModel: string;
  copilotReviewerModel?: string;
  cursorMcpConfigPath?: string;
  cursorModel: string;
  cursorReviewerModel?: string;
  doneSignal: string;
  driverEffort?: EffortLevel;
  driverEffortSource?: EffortSource;
  format: Format;
  geminiMcpConfigPath?: string;
  geminiModel: string;
  geminiReviewerModel?: string;
  governess?: boolean;
  governessCooldownSeconds: number;
  governessDryRun?: boolean;
  governessHeight: string;
  governessIdleSeconds: number;
  governessLlmTrace?: string;
  governessMaxRecoveries: number;
  governessModel: string;
  governessUrl: string;
  helperCavemanMode: CavemanMode;
  helperCavemanModeSource: CavemanModeSource;
  launchAttemptId?: string;
  launchClaimId?: string;
  maxIterations: number;
  pairedMode?: boolean;
  pairedSessionIds?: PairedSessionIds;
  pairWith?: Agent;
  promptInput?: string;
  proof: string;
  reservedRunId?: string;
  resumeRunId?: string;
  review?: ReviewMode;
  reviewerEffort?: EffortLevel;
  reviewerEffortSource?: EffortSource;
  reviewPlan?: PlanReviewMode;
  sessionId?: string;
  tmux?: boolean;
  workspace?: string;
  workspaceBinding?: LaunchWorkspaceBinding;
  worktree?: boolean;
}

export interface RunResult {
  combined: string;
  exitCode: number;
  parsed: string;
}

export interface ReviewFailure {
  reason: string;
  reviewer: Agent;
}

export interface ReviewOutcome extends ReviewFailure {
  status: ReviewStatus;
}

export interface ReviewResult {
  approved: boolean;
  consensusFail: boolean;
  failureCount: number;
  failures: ReviewFailure[];
  notes: string;
  reviews: ReviewOutcome[];
}

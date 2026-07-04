export type Agent = "claude" | "codex" | "gemini" | "cursor" | "copilot";
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
export type ValueFlag =
  | "agent"
  | "prompt"
  | "max"
  | "done"
  | "proof"
  | "pairWith"
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
  | "babysitIdle"
  | "babysitCooldown"
  | "babysitMaxRecoveries"
  | "babysitUrl"
  | "babysitModel"
  | "babysitHeight";

export type BabysitterAgentState =
  | "working"
  | "waiting-human"
  | "waiting-peer"
  | "stuck"
  | "crashed";

export interface BabysitterVerdict {
  confidence: number;
  state: BabysitterAgentState;
  suggestedAction?: string;
  summary: string;
}

// One normalized hook event, appended as a JSONL line by both agents' hooks.
export interface HookEvent {
  agent: Agent;
  cwd?: string;
  detail?: string;
  event: string;
  tool?: string;
  ts: string;
}

// --- Detector (babysitter-detect.ts) ---
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

// --- Recovery ladder (babysitter-recover.ts) ---
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

// --- Usage / cost (babysitter-usage.ts) ---
// Per-agent token/context/cost snapshot derived from the agent's session
// transcript. All token counts are cumulative for the session.
export interface AgentUsage {
  cacheCreateTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  firstTs?: string;
  inputTokens: number;
  lastTs?: string;
  model?: string;
  outputTokens: number;
  totalTokens: number;
}

// --- LLM judge (babysitter-llm.ts) ---
export interface JudgeRequest {
  agent: Agent;
  hookTail: HookEvent[];
  model: string;
  paneText: string;
  url: string;
}

export type JudgeFailureReason = "malformed" | "timeout" | "unreachable";

export type JudgeOutcome =
  | { ok: true; verdict: BabysitterVerdict }
  | { fallback: BabysitterVerdict; ok: false; reason: JudgeFailureReason };

export interface Options {
  agent: Agent;
  babysit?: boolean;
  babysitCooldownSeconds: number;
  babysitDryRun?: boolean;
  babysitHeight: string;
  babysitIdleSeconds: number;
  babysitMaxRecoveries: number;
  babysitModel: string;
  babysitUrl: string;
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
  format: Format;
  geminiMcpConfigPath?: string;
  geminiModel: string;
  geminiReviewerModel?: string;
  maxIterations: number;
  pairedMode?: boolean;
  pairedSessionIds?: PairedSessionIds;
  pairWith?: Agent;
  promptInput?: string;
  proof: string;
  resumeRunId?: string;
  review?: ReviewMode;
  reviewPlan?: PlanReviewMode;
  sessionId?: string;
  tmux?: boolean;
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

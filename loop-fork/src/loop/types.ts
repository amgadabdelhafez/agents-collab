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

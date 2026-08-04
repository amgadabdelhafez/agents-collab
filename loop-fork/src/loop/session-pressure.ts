import type { Agent, AgentUsage } from "./types";

export type SessionPressureMode = "enforce" | "observe" | "off";
export type SessionPressurePhase =
  | "handoff"
  | "hard-ceiling"
  | "healthy"
  | "prepare";
export type SessionPressureReasonCode =
  | "below-thresholds"
  | "context-handoff"
  | "context-prepare"
  | "first-compaction"
  | "multiple-compactions"
  | "turn-handoff"
  | "turn-prepare";

export interface SessionPressureProfile {
  contextHandoffTokens: number;
  id: string;
  turnHandoff: number;
}

export interface SessionPressureDecision {
  agent: Agent;
  assistantTurns: number;
  automaticCompactions?: number;
  compactionBasis: "automatic" | "provider-unspecified";
  compactions: number;
  contextHandoffTokens: number;
  contextPrepareTokens: number;
  contextTokens?: number;
  contextUsedPct?: number;
  model?: string;
  phase: SessionPressurePhase;
  profile: string;
  reason: string;
  reasonCode: SessionPressureReasonCode;
  turnHandoff: number;
  turnPrepare: number;
}

export type SessionPressureByAgent = Partial<
  Record<Agent, SessionPressureDecision>
>;

const GPT_56_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 185_000,
  id: "gpt-5.6-sol",
  turnHandoff: 18,
};
const GPT_55_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 225_000,
  id: "gpt-5.5",
  turnHandoff: 96,
};
const GPT_54_MINI_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 225_000,
  id: "gpt-5.4-mini",
  turnHandoff: 73,
};
const CODEX_SPARK_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 105_000,
  id: "codex-spark",
  turnHandoff: 11,
};
const CODEX_DEFAULT_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 185_000,
  id: "codex-default",
  turnHandoff: 40,
};
const CLAUDE_OPUS_48_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 230_000,
  id: "claude-opus-4.8",
  turnHandoff: 95,
};
const CLAUDE_OPUS_5_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 230_000,
  id: "claude-opus-5",
  turnHandoff: 90,
};
const CLAUDE_DEFAULT_PROFILE: SessionPressureProfile = {
  contextHandoffTokens: 230_000,
  id: "claude-default",
  turnHandoff: 90,
};

const normalizedModel = (model: string | undefined): string =>
  model?.trim().toLowerCase() ?? "";

export const sessionPressureProfile = (
  agent: Agent,
  model?: string
): SessionPressureProfile => {
  const normalized = normalizedModel(model);
  if (agent === "codex") {
    if (normalized.includes("spark")) {
      return CODEX_SPARK_PROFILE;
    }
    if (normalized.includes("gpt-5.6")) {
      return GPT_56_PROFILE;
    }
    if (normalized.includes("gpt-5.5")) {
      return GPT_55_PROFILE;
    }
    if (normalized.includes("gpt-5.4-mini")) {
      return GPT_54_MINI_PROFILE;
    }
    return CODEX_DEFAULT_PROFILE;
  }
  if (agent === "claude") {
    if (
      normalized.includes("opus-4.8") ||
      normalized.includes("opus-4-8") ||
      normalized.includes("opus 4.8")
    ) {
      return CLAUDE_OPUS_48_PROFILE;
    }
    if (normalized.includes("opus-5") || normalized.includes("opus 5")) {
      return CLAUDE_OPUS_5_PROFILE;
    }
    return CLAUDE_DEFAULT_PROFILE;
  }
  return CODEX_DEFAULT_PROFILE;
};

const prepareThreshold = (threshold: number): number =>
  Math.ceil(threshold * 0.75);

const measuredContext = (usage: AgentUsage): number | undefined =>
  Number.isFinite(usage.contextTokens) && usage.contextTokens > 0
    ? Math.round(usage.contextTokens)
    : undefined;

const decision = (
  agent: Agent,
  usage: AgentUsage,
  profile: SessionPressureProfile,
  phase: SessionPressurePhase,
  reasonCode: SessionPressureReasonCode,
  reason: string
): SessionPressureDecision => {
  const contextTokens = measuredContext(usage);
  const contextPrepareTokens = prepareThreshold(profile.contextHandoffTokens);
  const turnPrepare = prepareThreshold(profile.turnHandoff);
  return {
    agent,
    assistantTurns: Math.max(0, Math.round(usage.messages)),
    ...(usage.automaticCompactions === undefined
      ? {}
      : { automaticCompactions: usage.automaticCompactions }),
    compactionBasis:
      usage.automaticCompactions === undefined
        ? "provider-unspecified"
        : "automatic",
    compactions: Math.max(0, Math.round(usage.compactions)),
    contextHandoffTokens: profile.contextHandoffTokens,
    contextPrepareTokens,
    ...(contextTokens === undefined
      ? {}
      : {
          contextTokens,
          contextUsedPct: Math.round(
            (contextTokens / profile.contextHandoffTokens) * 100
          ),
        }),
    ...(usage.model ? { model: usage.model } : {}),
    phase,
    profile: profile.id,
    reason,
    reasonCode,
    turnHandoff: profile.turnHandoff,
    turnPrepare,
  };
};

export const evaluateSessionPressure = (
  agent: Agent,
  usage: AgentUsage
): SessionPressureDecision => {
  const profile = sessionPressureProfile(agent, usage.model);
  const contextTokens = measuredContext(usage);
  const assistantTurns = Math.max(0, Math.round(usage.messages));
  const effectiveCompactions =
    usage.automaticCompactions ?? Math.max(0, Math.round(usage.compactions));
  const contextPrepareTokens = prepareThreshold(profile.contextHandoffTokens);
  const turnPrepare = prepareThreshold(profile.turnHandoff);

  if (effectiveCompactions >= 2) {
    return decision(
      agent,
      usage,
      profile,
      "hard-ceiling",
      "multiple-compactions",
      `${effectiveCompactions} ${usage.automaticCompactions === undefined ? "provider-unspecified" : "automatic"} compactions reached the multi-compaction hard ceiling`
    );
  }
  if (effectiveCompactions >= 1) {
    return decision(
      agent,
      usage,
      profile,
      "handoff",
      "first-compaction",
      usage.automaticCompactions === undefined
        ? "first compaction observed; provider did not label its trigger"
        : "first automatic compaction observed"
    );
  }
  if (
    contextTokens !== undefined &&
    contextTokens >= profile.contextHandoffTokens
  ) {
    return decision(
      agent,
      usage,
      profile,
      "handoff",
      "context-handoff",
      `${contextTokens} context tokens reached ${profile.contextHandoffTokens}`
    );
  }
  if (assistantTurns >= profile.turnHandoff) {
    return decision(
      agent,
      usage,
      profile,
      "handoff",
      "turn-handoff",
      `${assistantTurns} assistant turns reached ${profile.turnHandoff}`
    );
  }
  if (contextTokens !== undefined && contextTokens >= contextPrepareTokens) {
    return decision(
      agent,
      usage,
      profile,
      "prepare",
      "context-prepare",
      `${contextTokens} context tokens reached preparation threshold ${contextPrepareTokens}`
    );
  }
  if (assistantTurns >= turnPrepare) {
    return decision(
      agent,
      usage,
      profile,
      "prepare",
      "turn-prepare",
      `${assistantTurns} assistant turns reached preparation threshold ${turnPrepare}`
    );
  }
  return decision(
    agent,
    usage,
    profile,
    "healthy",
    "below-thresholds",
    contextTokens === undefined
      ? `context unavailable; ${assistantTurns} assistant turns below ${profile.turnHandoff}`
      : `${contextTokens} context tokens and ${assistantTurns} assistant turns below thresholds`
  );
};

export const sessionPressureModeFromEnv = (
  env: NodeJS.ProcessEnv
): SessionPressureMode => {
  const value = env.LOOP_GOVERNESS_CONTEXT_HANDOFF?.trim().toLowerCase();
  if (value === "off" || value === "observe") {
    return value;
  }
  return "enforce";
};

export const pressureAtOrAboveHandoff = (
  decisionValue: SessionPressureDecision
): boolean =>
  decisionValue.phase === "handoff" || decisionValue.phase === "hard-ceiling";

const PHASE_RANK: Record<SessionPressurePhase, number> = {
  healthy: 0,
  prepare: 1,
  handoff: 2,
  "hard-ceiling": 3,
};

export const highestSessionPressure = (
  decisions: SessionPressureByAgent
): SessionPressureDecision | undefined =>
  Object.values(decisions).sort(
    (left, right) => PHASE_RANK[right.phase] - PHASE_RANK[left.phase]
  )[0];

const AGENTS = new Set<Agent>([
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
]);
const PHASES = new Set<SessionPressurePhase>([
  "handoff",
  "hard-ceiling",
  "healthy",
  "prepare",
]);
const REASON_CODES = new Set<SessionPressureReasonCode>([
  "below-thresholds",
  "context-handoff",
  "context-prepare",
  "first-compaction",
  "multiple-compactions",
  "turn-handoff",
  "turn-prepare",
]);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const readDecision = (value: unknown): SessionPressureDecision | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.agent !== "string" ||
    !AGENTS.has(record.agent as Agent) ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as SessionPressurePhase) ||
    typeof record.reasonCode !== "string" ||
    !REASON_CODES.has(record.reasonCode as SessionPressureReasonCode) ||
    typeof record.profile !== "string" ||
    typeof record.reason !== "string" ||
    !isFiniteNonNegative(record.assistantTurns) ||
    (record.compactionBasis !== "automatic" &&
      record.compactionBasis !== "provider-unspecified") ||
    !isFiniteNonNegative(record.compactions) ||
    !isFiniteNonNegative(record.contextHandoffTokens) ||
    !isFiniteNonNegative(record.contextPrepareTokens) ||
    !isFiniteNonNegative(record.turnHandoff) ||
    !isFiniteNonNegative(record.turnPrepare)
  ) {
    return undefined;
  }
  if (
    record.automaticCompactions !== undefined &&
    !isFiniteNonNegative(record.automaticCompactions)
  ) {
    return undefined;
  }
  if (
    record.contextTokens !== undefined &&
    !isFiniteNonNegative(record.contextTokens)
  ) {
    return undefined;
  }
  if (
    record.contextUsedPct !== undefined &&
    !isFiniteNonNegative(record.contextUsedPct)
  ) {
    return undefined;
  }
  if (record.model !== undefined && typeof record.model !== "string") {
    return undefined;
  }
  return record as unknown as SessionPressureDecision;
};

export const readSessionPressureByAgent = (
  value: unknown
): SessionPressureByAgent => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const decisions: SessionPressureByAgent = {};
  for (const candidate of Object.values(value)) {
    const parsed = readDecision(candidate);
    if (parsed) {
      decisions[parsed.agent] = parsed;
    }
  }
  return decisions;
};

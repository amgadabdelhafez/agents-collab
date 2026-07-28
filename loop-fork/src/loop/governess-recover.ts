import type {
  Agent,
  GovernessAgentState,
  GovernessVerdict,
  RecoveryDecision,
  RecoveryHistoryEntry,
  RecoveryLevel,
} from "./types";

// Re-export the shared contract types so consumers/tests can import them here.
export type {
  GovernessVerdict,
  RecoveryDecision,
  RecoveryHistoryEntry,
  RecoveryLevel,
} from "./types";
export type GovernessState = GovernessAgentState;

/** States for which auto-recovery is allowed. */
const RECOVERABLE_STATES: readonly GovernessState[] = ["stuck", "crashed"];

/** The escalation ladder: index grows with the number of prior recoveries. */
const RECOVERY_LADDER: readonly RecoveryLevel[] = [
  "answer-prompt",
  "nudge",
  "restart",
];

const isRecoverableState = (state: GovernessState): boolean =>
  RECOVERABLE_STATES.includes(state);

const latestEntry = (
  entries: readonly RecoveryHistoryEntry[]
): RecoveryHistoryEntry | null => {
  let latest: RecoveryHistoryEntry | null = null;
  for (const entry of entries) {
    if (latest === null || Date.parse(entry.ts) > Date.parse(latest.ts)) {
      latest = entry;
    }
  }
  return latest;
};

/**
 * Decide whether (and how) to auto-recover an agent, given the governess's
 * verdict, prior recovery history, and gating options. Pure: no clock access —
 * the current time is supplied via `opts.nowMs`.
 *
 * Gates are evaluated in order; the first match wins:
 * 1. state must be recoverable ("stuck"/"crashed")
 * 2. verdict.confidence must meet the confidence gate
 * 3. per-agent recovery count must be below `maxRecoveries`
 * 4. the last per-agent recovery must be outside the cooldown window
 * Otherwise the ladder escalates by the per-agent recovery count.
 */
export const decideRecovery = (
  verdict: GovernessVerdict,
  history: readonly RecoveryHistoryEntry[],
  agent: Agent,
  opts: {
    confidence: number;
    cooldownMs: number;
    maxRecoveries: number;
    nowMs: number;
  }
): RecoveryDecision => {
  if (!isRecoverableState(verdict.state)) {
    return {
      agent,
      level: null,
      reason: `state ${verdict.state} not recoverable`,
    };
  }

  if (verdict.confidence < opts.confidence) {
    return { agent, level: null, reason: "confidence below gate" };
  }

  const agentHistory = history.filter((entry) => entry.agent === agent);
  if (agentHistory.length >= opts.maxRecoveries) {
    return { agent, level: null, reason: "max recoveries reached" };
  }

  const last = latestEntry(agentHistory);
  if (last !== null && opts.nowMs - Date.parse(last.ts) < opts.cooldownMs) {
    return { agent, level: null, reason: "cooldown active" };
  }

  const index = Math.min(agentHistory.length, RECOVERY_LADDER.length - 1);
  const level = RECOVERY_LADDER[index];
  if (level === undefined) {
    throw new Error(`no recovery level for ladder index ${index}`);
  }

  return { agent, level, reason: `escalate to ${level}` };
};

/** Effectful side-doors for {@link executeRecovery}, injected for testability. */
export interface RecoveryDeps {
  answerPrompt: (agent: Agent) => void;
  log: (entry: RecoveryHistoryEntry, dryRun: boolean) => void;
  nudge: (agent: Agent) => void;
  restart: (agent: Agent) => void;
}

const runExecutor = (
  level: RecoveryLevel,
  agent: Agent,
  deps: RecoveryDeps
): void => {
  if (level === "answer-prompt") {
    deps.answerPrompt(agent);
    return;
  }
  if (level === "nudge") {
    deps.nudge(agent);
    return;
  }
  if (level === "restart") {
    deps.restart(agent);
    return;
  }
  throw new Error(`unknown recovery level ${level}`);
};

/**
 * Execute a recovery decision. Always logs the intended entry (with the dry-run
 * flag); only invokes the matching executor when `opts.dryRun` is false. Returns
 * the entry that was taken/intended, or `null` when the decision was to do
 * nothing.
 */
export const executeRecovery = (
  decision: RecoveryDecision,
  deps: RecoveryDeps,
  opts: { dryRun: boolean; nowIso: string }
): RecoveryHistoryEntry | null => {
  if (decision.level === null) {
    return null;
  }

  const entry: RecoveryHistoryEntry = {
    agent: decision.agent,
    level: decision.level,
    ts: opts.nowIso,
  };

  deps.log(entry, opts.dryRun);

  if (!opts.dryRun) {
    runExecutor(decision.level, decision.agent, deps);
  }

  return entry;
};

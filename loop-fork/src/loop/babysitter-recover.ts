import type { Agent } from "./types";

/**
 * NOTE (contract deviation): the task stated that `BabysitterVerdict`,
 * `RecoveryLevel`, `RecoveryHistoryEntry`, and `RecoveryDecision` already exist
 * in `src/loop/types.ts`. They do not — only `Agent` is defined there. Because
 * this module is only permitted to touch two files (and not edit `types.ts`),
 * these contract types are defined and exported here instead.
 */

/** A babysitter's assessment of what an agent is currently doing. */
export type BabysitterState =
  | "working"
  | "waiting-human"
  | "waiting-peer"
  | "stuck"
  | "crashed";

export interface BabysitterVerdict {
  state: BabysitterState;
  /** Confidence in the verdict, in the range [0, 1]. */
  confidence: number;
}

/** The recovery actions available, ordered from gentlest to most disruptive. */
export type RecoveryLevel = "answer-prompt" | "nudge" | "restart";

/** A record of a recovery action that was decided/taken for an agent. */
export interface RecoveryHistoryEntry {
  agent: Agent;
  level: RecoveryLevel;
  /** ISO-8601 timestamp of when the action occurred. */
  ts: string;
}

/**
 * The outcome of {@link decideRecovery}. A `null` level means "do nothing";
 * `reason` always explains the decision.
 */
export interface RecoveryDecision {
  agent: Agent;
  level: RecoveryLevel | null;
  reason: string;
}

/** States for which auto-recovery is allowed. */
const RECOVERABLE_STATES: readonly BabysitterState[] = ["stuck", "crashed"];

/** The escalation ladder: index grows with the number of prior recoveries. */
const RECOVERY_LADDER: readonly RecoveryLevel[] = [
  "answer-prompt",
  "nudge",
  "restart",
];

const isRecoverableState = (state: BabysitterState): boolean =>
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
 * Decide whether (and how) to auto-recover an agent, given the babysitter's
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
  verdict: BabysitterVerdict,
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
  nudge: (agent: Agent) => void;
  restart: (agent: Agent) => void;
  log: (entry: RecoveryHistoryEntry, dryRun: boolean) => void;
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

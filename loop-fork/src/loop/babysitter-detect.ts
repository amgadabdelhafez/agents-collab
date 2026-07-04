import type { Agent } from "./types";

/**
 * Deterministic stuck-detector for the babysitter feature.
 *
 * All functions are pure: no I/O and no wall-clock reads. Time is always
 * supplied by the caller via `nowMs` and ISO timestamps, which keeps the
 * detector testable with a fixed synthetic clock.
 *
 * NOTE: The contract types below are declared here rather than in
 * `src/loop/types.ts`. The task required importing them from `types.ts`, but
 * they do not yet exist there and this module is not permitted to edit
 * `types.ts`. Declaring and exporting them here keeps the module self-contained
 * and type-safe. Only `Agent` is imported from the shared contract.
 */

/** Minimum clamp for a computed event age; ages can never be negative. */
const MIN_EVENT_AGE_MS = 0;

/** A single observation of an agent's pane and most recent event. */
export interface AgentLivenessInput {
  agent: Agent;
  paneHash: string;
  lastEventTs?: string;
}

/** Persisted detector state carried between ticks. */
export interface AgentLivenessState {
  agent: Agent;
  paneHash: string;
  paneStableSinceMs: number;
  lastEventTs?: string;
}

/** Derived liveness signal for a single tick. */
export interface AgentLiveness {
  agent: Agent;
  lastEventAgeMs: number;
  paneStable: boolean;
  suspect: boolean;
}

/**
 * Create the initial detector state for an agent.
 *
 * The pane is considered "stable since now" and no event has been observed yet.
 */
export const initLivenessState = (
  agent: Agent,
  nowMs: number,
  paneHash = ""
): AgentLivenessState => ({
  agent,
  paneHash,
  paneStableSinceMs: nowMs,
  lastEventTs: undefined,
});

/**
 * Compute the age of the most recent event relative to `nowMs`.
 *
 * Returns positive infinity when there is no timestamp or it cannot be parsed,
 * and clamps to a non-negative value so future timestamps never yield a
 * negative age.
 */
const computeEventAgeMs = (
  lastEventTs: string | undefined,
  nowMs: number
): number => {
  if (!lastEventTs) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(lastEventTs);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(MIN_EVENT_AGE_MS, nowMs - parsed);
};

/**
 * Advance the detector by one tick.
 *
 * An agent is "suspect" (potentially stuck) when its pane hash has not changed
 * for at least `idleMs` AND its most recent event is at least `idleMs` old.
 */
export const updateLiveness = (
  prev: AgentLivenessState,
  input: AgentLivenessInput,
  nowMs: number,
  idleMs: number
): { state: AgentLivenessState; liveness: AgentLiveness } => {
  const paneChanged = input.paneHash !== prev.paneHash;
  const paneStableSinceMs = paneChanged ? nowMs : prev.paneStableSinceMs;
  const lastEventTs = input.lastEventTs ?? prev.lastEventTs;

  const lastEventAgeMs = computeEventAgeMs(lastEventTs, nowMs);
  const paneStable = nowMs - paneStableSinceMs >= idleMs;
  const eventsStale = lastEventAgeMs >= idleMs;
  const suspect = paneStable && eventsStale;

  const state: AgentLivenessState = {
    agent: input.agent,
    paneHash: input.paneHash,
    paneStableSinceMs,
    lastEventTs,
  };

  const liveness: AgentLiveness = {
    agent: input.agent,
    lastEventAgeMs,
    paneStable,
    suspect,
  };

  return { state, liveness };
};

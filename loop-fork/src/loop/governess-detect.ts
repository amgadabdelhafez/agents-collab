import type {
  Agent,
  AgentLiveness,
  AgentLivenessInput,
  AgentLivenessState,
} from "./types";

/**
 * Deterministic stuck-detector for the governess feature.
 *
 * All functions are pure: no I/O and no wall-clock reads. Time is always
 * supplied by the caller via `nowMs` and ISO timestamps, which keeps the
 * detector testable with a fixed synthetic clock.
 */

// Re-export the shared contract types so consumers/tests can import them here.
export type {
  AgentLiveness,
  AgentLivenessInput,
  AgentLivenessState,
} from "./types";

/** Minimum clamp for a computed event age; ages can never be negative. */
const MIN_EVENT_AGE_MS = 0;

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
    paneIdleMs: Math.max(MIN_EVENT_AGE_MS, nowMs - paneStableSinceMs),
    paneStable,
    suspect,
  };

  return { state, liveness };
};

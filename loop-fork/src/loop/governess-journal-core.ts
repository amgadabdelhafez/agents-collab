// The pure governess control reducer.
//
// gov-6 moves the governess beat onto a Temporal workflow whose history is the
// authoritative event log. Two consumers must agree exactly on what a control
// record is: the legacy JSONL writer in governess-journal.ts and the
// governess-beat.v1 WorkflowDefinition in governess-beat-workflow.ts. Sharing
// one reducer is what makes "the exported journal equals the old JSONL journal"
// a property rather than a coincidence.
//
// Nothing here touches the filesystem, the clock, a random source, or any Node
// built-in. Every non-deterministic input (controlId, timestamp) and every
// derived hash is supplied by the caller, so this module bundles cleanly into
// the Temporal workflow sandbox and replays deterministically. A Node crypto
// import here would break the webpack workflow bundle.

import type {
  GovernessAction,
  GovernessActionClass,
  GovernessPolicyContext,
} from "./governess-policy";
import type { Agent } from "./types";

export type GovernessControlPhase =
  | "prepared"
  | "dispatched"
  | "accepted"
  | "acknowledged"
  | "completed"
  | "failed";

export interface GovernessControlRecord {
  action: GovernessAction;
  agent?: Agent;
  at: string;
  controlId: string;
  epoch: number;
  evidence?: string;
  idempotencyKey: string;
  observationStream?: string;
  // Observation results are retained so replay can reconstruct decisions.
  // Effectful control messages remain hash-only to avoid duplicating prompts.
  payload?: string;
  payloadHash: string;
  phase: GovernessControlPhase;
  policyClass: GovernessActionClass;
  policyContext?: GovernessPolicyContext;
  reason?: string;
  semanticHash?: string;
  sequence: number;
  transport?: GovernessControlTransport;
}

export type GovernessControlTransport =
  | "claude-channel"
  | "codex-app-server"
  | "bridge"
  | "tmux-fallback"
  | "internal";

export interface GovernessControlTransitionDetails {
  evidence?: string;
  transport?: GovernessControlTransport;
}

export const GOVERNESS_OBSERVATION_HEARTBEAT_MS = 60_000;

const CONTROL_PHASES = new Set<GovernessControlPhase>([
  "prepared",
  "dispatched",
  "accepted",
  "acknowledged",
  "completed",
  "failed",
]);

const PHASE_ORDER: Record<GovernessControlPhase, number> = {
  prepared: 0,
  dispatched: 1,
  accepted: 2,
  acknowledged: 3,
  completed: 4,
  failed: 5,
};

export const governessTransitionAllowed = (
  from: GovernessControlPhase,
  to: GovernessControlPhase
): boolean => {
  if (from === to) {
    return true;
  }
  if (from === "completed" || from === "failed") {
    return false;
  }
  if (to === "failed") {
    return true;
  }
  return PHASE_ORDER[to] > PHASE_ORDER[from];
};

export const isGovernessControlRecord = (
  value: unknown
): value is GovernessControlRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<GovernessControlRecord>;
  return (
    typeof record.action === "string" &&
    typeof record.at === "string" &&
    typeof record.controlId === "string" &&
    typeof record.epoch === "number" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.payloadHash === "string" &&
    typeof record.phase === "string" &&
    CONTROL_PHASES.has(record.phase as GovernessControlPhase) &&
    typeof record.policyClass === "string" &&
    typeof record.sequence === "number" &&
    Number.isInteger(record.sequence) &&
    record.sequence > 0
  );
};

/**
 * The reducer's fold state. This is exactly the legacy journal index without the
 * filesystem stat fields, so the JSONL index and the workflow state stay in
 * lockstep by construction.
 */
export interface GovernessControlState {
  dispatchedControls: Record<string, true>;
  latestByControl: Record<string, GovernessControlRecord>;
  latestByIdempotency: Record<string, GovernessControlRecord>;
  latestObservationByStream: Record<string, GovernessControlRecord>;
  pendingHistoryByControl: Record<string, GovernessControlRecord[]>;
  sequence: number;
}

export const emptyGovernessControlState = (): GovernessControlState => ({
  dispatchedControls: {},
  latestByControl: {},
  latestByIdempotency: {},
  latestObservationByStream: {},
  pendingHistoryByControl: {},
  sequence: 0,
});

export const applyGovernessControlRecord = (
  state: GovernessControlState,
  record: GovernessControlRecord
): void => {
  state.sequence = Math.max(state.sequence, record.sequence);
  if (record.action === "observe-runtime") {
    if (record.observationStream) {
      state.latestObservationByStream[record.observationStream] = record;
    }
    return;
  }
  state.latestByControl[record.controlId] = record;
  state.latestByIdempotency[record.idempotencyKey] = record;
  if (record.phase === "dispatched") {
    state.dispatchedControls[record.controlId] = true;
  }
  const history = state.pendingHistoryByControl[record.controlId] ?? [];
  history.push(record);
  if (record.phase === "completed" || record.phase === "failed") {
    delete state.pendingHistoryByControl[record.controlId];
  } else {
    state.pendingHistoryByControl[record.controlId] = history;
  }
};

export const foldGovernessControlRecords = (
  records: readonly GovernessControlRecord[]
): GovernessControlState => {
  const state = emptyGovernessControlState();
  for (const record of records) {
    applyGovernessControlRecord(state, record);
  }
  return state;
};

export interface GovernessPrepareInput {
  action: GovernessAction;
  agent?: Agent;
  at: string;
  epoch: number;
  idempotencyKey: string;
  /** Retained only for observe-runtime; never a prompt body. */
  payload?: string;
  /** Hashed by the caller, so no prompt body ever reaches this reducer. */
  payloadHash: string;
  policyClass: GovernessActionClass;
  policyContext?: GovernessPolicyContext;
}

export interface GovernessObservationInput {
  agent?: Agent;
  at: string;
  epoch: number;
  heartbeatMs?: number;
  idempotencyKey: string;
  payload: string;
  payloadHash: string;
  policyClass: GovernessActionClass;
  policyContext?: GovernessPolicyContext;
  semanticHash: string;
  stream: string;
}

/**
 * `appended` is true when the caller must durably record the returned record.
 * A false value means the reducer reused an existing record and no new event
 * belongs in the log.
 */
export interface GovernessControlDecision {
  appended: boolean;
  record: GovernessControlRecord;
}

export const decideGovernessPrepare = (
  state: GovernessControlState,
  input: GovernessPrepareInput,
  controlId: string
): GovernessControlDecision => {
  const existing = state.latestByIdempotency[input.idempotencyKey];
  if (existing) {
    const dispatched = state.dispatchedControls[existing.controlId] === true;
    // A pre-dispatch failure is safe to retry with a new control id. Once an
    // effect may have crossed the transport boundary, failure is ambiguous and
    // the idempotency fence must remain closed.
    if (existing.phase !== "failed" || dispatched) {
      return { appended: false, record: existing };
    }
  }
  return {
    appended: true,
    record: {
      action: input.action,
      ...(input.agent ? { agent: input.agent } : {}),
      at: input.at,
      controlId,
      epoch: input.epoch,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      ...(input.action === "observe-runtime" && input.payload !== undefined
        ? { payload: input.payload }
        : {}),
      phase: "prepared",
      policyClass: input.policyClass,
      ...(input.policyContext ? { policyContext: input.policyContext } : {}),
      sequence: state.sequence + 1,
    },
  };
};

export const decideGovernessObservation = (
  state: GovernessControlState,
  input: GovernessObservationInput,
  controlId: string
): GovernessControlDecision => {
  const semanticHash = input.semanticHash;
  const previous = state.latestObservationByStream[input.stream];
  const elapsedMs = previous
    ? Math.max(0, Date.parse(input.at) - Date.parse(previous.at))
    : Number.POSITIVE_INFINITY;
  if (
    previous?.semanticHash === semanticHash &&
    elapsedMs < (input.heartbeatMs ?? GOVERNESS_OBSERVATION_HEARTBEAT_MS)
  ) {
    return { appended: false, record: previous };
  }
  return {
    appended: true,
    record: {
      action: "observe-runtime",
      ...(input.agent ? { agent: input.agent } : {}),
      at: input.at,
      controlId,
      epoch: input.epoch,
      idempotencyKey: input.idempotencyKey,
      observationStream: input.stream,
      payload: input.payload,
      payloadHash: input.payloadHash,
      phase: "completed",
      policyClass: input.policyClass,
      ...(input.policyContext ? { policyContext: input.policyContext } : {}),
      semanticHash,
      sequence: state.sequence + 1,
    },
  };
};

/**
 * Returns undefined when the control id is unknown. Throws on a transition the
 * phase lattice forbids, matching the legacy writer's contract exactly.
 */
export const decideGovernessTransition = (
  state: GovernessControlState,
  controlId: string,
  phase: GovernessControlPhase,
  at: string,
  reason?: string,
  details: GovernessControlTransitionDetails = {}
): GovernessControlDecision | undefined => {
  const previous = state.latestByControl[controlId];
  if (!previous) {
    return undefined;
  }
  if (previous.phase === phase) {
    return { appended: false, record: previous };
  }
  if (!governessTransitionAllowed(previous.phase, phase)) {
    throw new Error(
      `invalid governess control transition ${previous.phase} -> ${phase}`
    );
  }
  return {
    appended: true,
    record: {
      ...previous,
      at,
      phase,
      ...(details.evidence ? { evidence: details.evidence } : {}),
      ...(details.transport ? { transport: details.transport } : {}),
      ...(reason ? { reason } : {}),
      sequence: state.sequence + 1,
    },
  };
};

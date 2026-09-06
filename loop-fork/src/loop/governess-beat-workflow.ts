// gov-6: the governess beat as a Temporal workflow.
//
// The ordered, replayable event log the governess needs is exactly what a
// workflow history already is, so this definition stops reimplementing one. Each
// beat is a signal; the decision it produces is a state transition. The JSONL
// journal becomes a read model exported from this state
// (see exportGovernessJournal below and governess-journal.ts).
//
// AUDIT CONTRACT: history carries metadata only. Effectful control payloads
// cross the boundary as `payloadHash`, never as a body. `payload` survives only
// for `observe-runtime`, which is runtime output rather than a prompt, and is
// what lets replay reconstruct decisions. Callers must hash before signalling.
//
// DETERMINISM: this definition never reads a clock or a random source. The
// control id and timestamp arrive in the signal payload, so Temporal replay of
// the same history reproduces the same decision sequence exactly.

import {
  applyGovernessControlRecord,
  decideGovernessObservation,
  decideGovernessPrepare,
  decideGovernessTransition,
  foldGovernessControlRecords,
  type GovernessControlPhase,
  type GovernessControlRecord,
  type GovernessControlState,
  type GovernessControlTransitionDetails,
  isGovernessControlRecord,
} from "./governess-journal-core";
import type {
  JsonObject,
  JsonValue,
  WorkflowDefinition,
} from "./workflow-port";
import { WorkflowError } from "./workflow-port";

export const GOVERNESS_BEAT_WORKFLOW_TYPE = "governess-beat.v1";

/**
 * One beat workflow per run, not per seat.
 *
 * The journal's invariants are run-global: the idempotency fence, the monotonic
 * sequence counter, and observation-stream dedupe all key across every seat in
 * the run. Sharding per seat would split that fence into independent counters,
 * producing duplicate sequence numbers with no total order and letting the same
 * idempotency key pass twice on two seats. Seat identity already travels as the
 * `agent` field and inside `observationStream`, so per-seat isolation is
 * expressible inside one history without splitting the fence.
 */
export const governessBeatWorkflowId = (runId: string): string =>
  `governess-beat:${runId}`;

interface GovernessBeatState extends JsonObject {
  epoch: number;
  records: GovernessControlRecord[];
  runId: string;
}

const asState = (state: JsonObject): GovernessBeatState =>
  state as unknown as GovernessBeatState;

const stateOf = (state: GovernessBeatState): GovernessControlState =>
  foldGovernessControlRecords(state.records);

const asJson = (value: unknown): JsonValue => value as unknown as JsonValue;

const requireString = (payload: JsonObject, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowError(
      "invalid-command",
      `governess beat signal requires string ${key}`
    );
  }
  return value;
};

const requireNumber = (payload: JsonObject, key: string): number => {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowError(
      "invalid-command",
      `governess beat signal requires number ${key}`
    );
  }
  return value;
};

const optionalString = (
  payload: JsonObject,
  key: string
): string | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkflowError(
      "invalid-command",
      `governess beat signal field ${key} must be a string`
    );
  }
  return value;
};

/**
 * The audit fence. A caller that tries to put a prompt body in history is
 * rejected at the boundary rather than quietly recorded, so proof check 3 fails
 * loudly if someone later widens the signal.
 */
const rejectPromptBody = (payload: JsonObject, action: string): void => {
  if (action === "observe-runtime") {
    return;
  }
  if (payload.payload !== undefined) {
    throw new WorkflowError(
      "invalid-command",
      "governess beat history is metadata only: send payloadHash, not payload"
    );
  }
};

const appendDecision = (
  state: GovernessBeatState,
  decision: { appended: boolean; record: GovernessControlRecord } | undefined
): {
  changed: boolean;
  next: GovernessBeatState;
  record?: GovernessControlRecord;
} => {
  if (!decision) {
    return { changed: false, next: state };
  }
  if (!decision.appended) {
    return { changed: false, next: state, record: decision.record };
  }
  return {
    changed: true,
    next: {
      ...state,
      epoch: Math.max(state.epoch, decision.record.epoch),
      records: [...state.records, decision.record],
    },
    record: decision.record,
  };
};

const parsePhase = (payload: JsonObject): GovernessControlPhase => {
  const phase = requireString(payload, "phase");
  const allowed: GovernessControlPhase[] = [
    "prepared",
    "dispatched",
    "accepted",
    "acknowledged",
    "completed",
    "failed",
  ];
  if (!allowed.includes(phase as GovernessControlPhase)) {
    throw new WorkflowError(
      "invalid-command",
      `unknown governess control phase ${phase}`
    );
  }
  return phase as GovernessControlPhase;
};

const parseDetails = (
  payload: JsonObject
): GovernessControlTransitionDetails => {
  const details = payload.details;
  if (details === undefined || details === null) {
    return {};
  }
  if (typeof details !== "object" || Array.isArray(details)) {
    throw new WorkflowError(
      "invalid-command",
      "governess beat transition details must be an object"
    );
  }
  const record = details as JsonObject;
  return {
    ...(optionalString(record, "evidence")
      ? { evidence: optionalString(record, "evidence") }
      : {}),
    ...(optionalString(record, "transport")
      ? {
          transport: optionalString(
            record,
            "transport"
          ) as GovernessControlTransitionDetails["transport"],
        }
      : {}),
  };
};

/**
 * The read model. Exporting the journal from history is a projection of the
 * ordered record list, so it is total-ordered by construction and carries the
 * same content the JSONL writer would have appended for the same beats.
 */
export const exportGovernessJournal = (
  state: JsonObject
): GovernessControlRecord[] => {
  const records = asState(state).records;
  if (!(Array.isArray(records) && records.every(isGovernessControlRecord))) {
    throw new WorkflowError(
      "invalid-state",
      "governess beat state does not hold a valid record log"
    );
  }
  return records.map((record) => ({ ...record }));
};

export const governessBeatWorkflowDefinition: WorkflowDefinition = {
  cancel(stateValue, _reason, _context) {
    return { state: asState(stateValue), status: "canceled" };
  },

  query(stateValue, name, args): JsonValue {
    const state = asState(stateValue);
    if (name === "journal") {
      return asJson(exportGovernessJournal(state));
    }
    if (name === "pending_controls") {
      const folded = stateOf(state);
      return asJson(
        Object.values(folded.pendingHistoryByControl)
          .flat()
          .sort((left, right) => left.sequence - right.sequence)
      );
    }
    if (name === "latest_by_idempotency") {
      const key = requireString((args ?? {}) as JsonObject, "idempotencyKey");
      const found = stateOf(state).latestByIdempotency[key];
      return found ? asJson(found) : null;
    }
    throw new WorkflowError(
      "unknown-query",
      `unknown GovernessBeat query ${name}`
    );
  },

  signal(stateValue, name, payload, context) {
    const state = asState(stateValue);
    const folded = stateOf(state);

    if (name === "prepare_control") {
      const action = requireString(payload, "action");
      rejectPromptBody(payload, action);
      const applied = appendDecision(
        state,
        decideGovernessPrepare(
          folded,
          {
            action: action as GovernessControlRecord["action"],
            ...(optionalString(payload, "agent")
              ? { agent: optionalString(payload, "agent") as never }
              : {}),
            at: optionalString(payload, "at") ?? context.at,
            epoch: requireNumber(payload, "epoch"),
            idempotencyKey: requireString(payload, "idempotencyKey"),
            // Callers hash before signalling; the body never enters history.
            payloadHash: requireString(payload, "payloadHash"),
            policyClass: requireString(
              payload,
              "policyClass"
            ) as GovernessControlRecord["policyClass"],
          },
          requireString(payload, "controlId")
        )
      );
      return {
        changed: applied.changed,
        ...(applied.record ? { result: asJson(applied.record) } : {}),
        state: applied.next,
      };
    }

    if (name === "record_observation") {
      const applied = appendDecision(
        state,
        decideGovernessObservation(
          folded,
          {
            ...(optionalString(payload, "agent")
              ? { agent: optionalString(payload, "agent") as never }
              : {}),
            at: optionalString(payload, "at") ?? context.at,
            epoch: requireNumber(payload, "epoch"),
            idempotencyKey: requireString(payload, "idempotencyKey"),
            payload: requireString(payload, "payload"),
            payloadHash: requireString(payload, "payloadHash"),
            policyClass: requireString(
              payload,
              "policyClass"
            ) as GovernessControlRecord["policyClass"],
            semanticHash: requireString(payload, "semanticHash"),
            stream: requireString(payload, "stream"),
          },
          requireString(payload, "controlId")
        )
      );
      return {
        changed: applied.changed,
        ...(applied.record ? { result: asJson(applied.record) } : {}),
        state: applied.next,
      };
    }

    if (name === "transition_control") {
      const applied = appendDecision(
        state,
        decideGovernessTransition(
          folded,
          requireString(payload, "controlId"),
          parsePhase(payload),
          optionalString(payload, "at") ?? context.at,
          optionalString(payload, "reason"),
          parseDetails(payload)
        )
      );
      return {
        changed: applied.changed,
        ...(applied.record ? { result: asJson(applied.record) } : {}),
        state: applied.next,
      };
    }

    throw new WorkflowError(
      "unknown-signal",
      `unknown GovernessBeat signal ${name}`
    );
  },

  start(input, _context) {
    const runId = requireString(input, "runId");
    const state: GovernessBeatState = {
      epoch: 0,
      records: [],
      runId,
    };
    return { result: governessBeatWorkflowId(runId), state };
  },

  type: GOVERNESS_BEAT_WORKFLOW_TYPE,
};

/**
 * Fold a decision log back into the index the JSONL reader exposes. Used by the
 * journal read model so history and file agree on derived state, not just on the
 * record list.
 */
export const governessBeatIndex = (
  records: readonly GovernessControlRecord[]
): GovernessControlState => {
  const state = foldGovernessControlRecords([]);
  for (const record of records) {
    applyGovernessControlRecord(state, record);
  }
  return state;
};

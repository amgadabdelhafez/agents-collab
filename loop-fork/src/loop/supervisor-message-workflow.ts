import {
  type JsonObject,
  type JsonValue,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowExecutionStatus,
  type WorkflowTransitionContext,
  type WorkflowTransitionResult,
} from "./workflow-port";

export const SUPERVISOR_MESSAGE_WORKFLOW_TYPE = "supervisor-message.v1";

export type SupervisorMessagePhase =
  | "routed"
  | "retry-scheduled"
  | "escalated"
  | "claimed"
  | "acknowledged"
  | "dead-lettered"
  | "canceled";

export interface SupervisorMessagePolicy extends JsonObject {
  claimTimeoutMs: number;
  escalationTimeoutMs: number;
  maxDeliveryAttempts: number;
  retryDelayMs: number;
}

export interface SupervisorMessageInput extends JsonObject {
  artifactRefs: string[];
  body: string;
  dedupeKey: string;
  from: string;
  messageId: string;
  policy: SupervisorMessagePolicy;
  receivedAt: string;
  threadId: string;
  to: string;
}

interface SupervisorMessageEvent extends JsonObject {
  at: string;
  kind: string;
}

interface SupervisorMessageState extends JsonObject {
  acknowledgedAt: null | string;
  artifactRefs: string[];
  body: string;
  canceledAt: null | string;
  claimBy: string;
  claimedAt: null | string;
  claimedBy: null | string;
  deadLetteredAt: null | string;
  dedupeKey: string;
  deliveredAt: null | string;
  deliveryAttempts: number;
  deliveryStatus: "accepted" | "pending" | "retry-scheduled";
  escalatedAt: null | string;
  escalationDeadline: null | string;
  events: SupervisorMessageEvent[];
  from: string;
  lastFailure: null | string;
  messageId: string;
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
  policy: SupervisorMessagePolicy;
  receivedAt: string;
  threadId: string;
  to: string;
}

export interface SupervisorMessageProjection extends JsonObject {
  acknowledgedAt: null | string;
  actionRequired: "acknowledge" | "claim" | "dead-letter" | "none" | "retry";
  artifactRefs: string[];
  claimedAt: null | string;
  claimedBy: null | string;
  deadLetteredAt: null | string;
  deliveredAt: null | string;
  deliveryAttempts: number;
  escalatedAt: null | string;
  from: string;
  messageId: string;
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
  receivedAt: string;
  schema: "supervisor-message-status.v1";
  threadId: string;
  to: string;
}

export interface SupervisorMessageDeliveryRequest extends JsonObject {
  artifactRefs: string[];
  body: string;
  idempotencyKey: string;
  messageId: string;
  target: string;
  threadId: string;
}

const SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_BODY_BYTES = 32_768;
const MAX_ARTIFACT_REFS = 32;
const MAX_POLICY_MS = 30 * 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
  record: Record<string, unknown>,
  field: string,
  pattern?: RegExp
): string => {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage ${field} must be non-empty`
    );
  }
  if (pattern && !pattern.test(value)) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage ${field} is invalid`
    );
  }
  return value;
};

const requireCanonicalUtc = (
  record: Record<string, unknown>,
  field: string
): string => {
  const value = requireString(record, field, CANONICAL_UTC_RE);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage ${field} must be a real canonical UTC instant`
    );
  }
  return value;
};

const requireBoundedInteger = (
  record: Record<string, unknown>,
  field: string,
  maximum: number
): number => {
  const value = record[field];
  if (
    !(
      Number.isSafeInteger(value) &&
      Number(value) > 0 &&
      Number(value) <= maximum
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage policy ${field} must be a positive bounded integer`
    );
  }
  return Number(value);
};

const parsePolicy = (value: unknown): SupervisorMessagePolicy => {
  if (!isRecord(value)) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage policy must be an object"
    );
  }
  return {
    claimTimeoutMs: requireBoundedInteger(
      value,
      "claimTimeoutMs",
      MAX_POLICY_MS
    ),
    escalationTimeoutMs: requireBoundedInteger(
      value,
      "escalationTimeoutMs",
      MAX_POLICY_MS
    ),
    maxDeliveryAttempts: requireBoundedInteger(
      value,
      "maxDeliveryAttempts",
      20
    ),
    retryDelayMs: requireBoundedInteger(value, "retryDelayMs", MAX_POLICY_MS),
  };
};

const parseArtifactRefs = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_REFS) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage artifactRefs must contain at most ${MAX_ARTIFACT_REFS} entries`
    );
  }
  if (
    !value.every(
      (entry): entry is string =>
        typeof entry === "string" && ARTIFACT_REF_RE.test(entry)
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage artifactRefs require content-addressed artifact URIs"
    );
  }
  return [...new Set(value)];
};

const parseInput = (input: JsonObject): SupervisorMessageInput => {
  const body = requireString(input, "body");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage body exceeds ${MAX_BODY_BYTES} bytes`
    );
  }
  return {
    artifactRefs: parseArtifactRefs(input.artifactRefs),
    body,
    dedupeKey: requireString(input, "dedupeKey", STABLE_ID_RE),
    from: requireString(input, "from", SUPERVISOR_ID_RE),
    messageId: requireString(input, "messageId", STABLE_ID_RE),
    policy: parsePolicy(input.policy),
    receivedAt: requireCanonicalUtc(input, "receivedAt"),
    threadId: requireString(input, "threadId", STABLE_ID_RE),
    to: requireString(input, "to", SUPERVISOR_ID_RE),
  };
};

const asState = (state: JsonObject): SupervisorMessageState =>
  state as SupervisorMessageState;

const atMs = (value: string): number => Date.parse(value);
const plusMs = (at: string, durationMs: number): string =>
  new Date(atMs(at) + durationMs).toISOString();

const appendEvent = (
  state: SupervisorMessageState,
  kind: string,
  at: string
): SupervisorMessageEvent[] => [...state.events, { at, kind }];

const terminalStatus = (
  phase: SupervisorMessagePhase
): WorkflowExecutionStatus => {
  if (phase === "acknowledged") {
    return "completed";
  }
  if (phase === "dead-lettered") {
    return "failed";
  }
  if (phase === "canceled") {
    return "canceled";
  }
  return "running";
};

const requirePhase = (
  state: SupervisorMessageState,
  allowed: readonly SupervisorMessagePhase[],
  signal: string
): void => {
  if (!allowed.includes(state.phase)) {
    throw new WorkflowError(
      "invalid-state",
      `${signal} is invalid while SupervisorMessage is ${state.phase}`
    );
  }
};

const projectionOf = (
  state: SupervisorMessageState
): SupervisorMessageProjection => {
  let actionRequired: SupervisorMessageProjection["actionRequired"] = "none";
  if (state.phase === "routed" || state.phase === "escalated") {
    actionRequired = "claim";
  } else if (state.phase === "claimed") {
    actionRequired = "acknowledge";
  } else if (state.phase === "retry-scheduled") {
    actionRequired = "retry";
  } else if (state.phase === "dead-lettered") {
    actionRequired = "dead-letter";
  }
  return {
    acknowledgedAt: state.acknowledgedAt,
    actionRequired,
    artifactRefs: [...state.artifactRefs],
    claimedAt: state.claimedAt,
    claimedBy: state.claimedBy,
    deadLetteredAt: state.deadLetteredAt,
    deliveredAt: state.deliveredAt,
    deliveryAttempts: state.deliveryAttempts,
    escalatedAt: state.escalatedAt,
    from: state.from,
    messageId: state.messageId,
    nextRetryAt: state.nextRetryAt,
    phase: state.phase,
    receivedAt: state.receivedAt,
    schema: "supervisor-message-status.v1",
    threadId: state.threadId,
    to: state.to,
  };
};

const deliveryRequestOf = (
  state: SupervisorMessageState,
  workflowId: string
): SupervisorMessageDeliveryRequest => ({
  artifactRefs: [...state.artifactRefs],
  body: state.body,
  idempotencyKey: `${workflowId}:delivery:${state.deliveryAttempts + 1}`,
  messageId: state.messageId,
  target: state.to,
  threadId: state.threadId,
});

const deliveryFailed = (
  state: SupervisorMessageState,
  payload: JsonObject,
  context: WorkflowTransitionContext
): WorkflowTransitionResult => {
  requirePhase(state, ["routed"], "delivery_failed");
  const reason = requireString(payload, "reason");
  const permanent = payload.permanent === true;
  const attempts = state.deliveryAttempts + 1;
  if (permanent || attempts >= state.policy.maxDeliveryAttempts) {
    const next: SupervisorMessageState = {
      ...state,
      deadLetteredAt: context.at,
      deliveryAttempts: attempts,
      events: appendEvent(state, "dead-lettered", context.at),
      lastFailure: reason,
      nextRetryAt: null,
      phase: "dead-lettered",
    };
    return { state: next, status: "failed" };
  }
  const nextRetryAt = plusMs(context.at, state.policy.retryDelayMs);
  const next: SupervisorMessageState = {
    ...state,
    deliveryAttempts: attempts,
    deliveryStatus: "retry-scheduled",
    events: appendEvent(state, "retry-scheduled", context.at),
    lastFailure: reason,
    nextRetryAt,
    phase: "retry-scheduled",
  };
  return { state: next };
};

const clockTick = (
  state: SupervisorMessageState,
  context: WorkflowTransitionContext
): WorkflowTransitionResult => {
  if (
    state.phase === "retry-scheduled" &&
    state.nextRetryAt !== null &&
    atMs(context.at) >= atMs(state.nextRetryAt)
  ) {
    const next: SupervisorMessageState = {
      ...state,
      deliveryStatus: "pending",
      events: appendEvent(state, "retry-due", context.at),
      nextRetryAt: null,
      phase: "routed",
    };
    return { result: { action: "deliver" }, state: next };
  }
  if (
    state.phase === "routed" &&
    state.deliveredAt !== null &&
    atMs(context.at) >= atMs(state.claimBy)
  ) {
    const next: SupervisorMessageState = {
      ...state,
      escalatedAt: context.at,
      escalationDeadline: plusMs(context.at, state.policy.escalationTimeoutMs),
      events: appendEvent(state, "escalated", context.at),
      phase: "escalated",
    };
    return { state: next };
  }
  if (
    state.phase === "escalated" &&
    state.escalationDeadline !== null &&
    atMs(context.at) >= atMs(state.escalationDeadline)
  ) {
    const next: SupervisorMessageState = {
      ...state,
      deadLetteredAt: context.at,
      events: appendEvent(state, "dead-lettered-unclaimed", context.at),
      phase: "dead-lettered",
    };
    return { state: next, status: "failed" };
  }
  return { changed: false, result: { changed: false }, state };
};

export const supervisorMessageWorkflowDefinition: WorkflowDefinition = {
  cancel(stateValue, reason, context) {
    const state = asState(stateValue);
    const next: SupervisorMessageState = {
      ...state,
      canceledAt: context.at,
      events: appendEvent(state, `canceled:${reason}`, context.at),
      phase: "canceled",
    };
    return { state: next, status: "canceled" };
  },

  query(stateValue, name, args): JsonValue {
    const state = asState(stateValue);
    if (name === "status") {
      return projectionOf(state);
    }
    if (name === "delivery_request") {
      const workflowId = requireString(args ?? {}, "workflowId");
      requirePhase(state, ["routed"], "delivery_request");
      return deliveryRequestOf(state, workflowId);
    }
    if (name === "event_kinds") {
      return state.events.map((event) => event.kind);
    }
    throw new WorkflowError(
      "unknown-query",
      `unknown SupervisorMessage query ${name}`
    );
  },

  signal(stateValue, name, payload, context) {
    const state = asState(stateValue);
    if (name === "delivery_succeeded") {
      requirePhase(state, ["routed"], name);
      const attempts = state.deliveryAttempts + 1;
      const next: SupervisorMessageState = {
        ...state,
        deliveredAt: context.at,
        deliveryAttempts: attempts,
        deliveryStatus: "accepted",
        events: appendEvent(state, "delivery-accepted", context.at),
        lastFailure: null,
        nextRetryAt: null,
      };
      return { state: next };
    }
    if (name === "delivery_failed") {
      return deliveryFailed(state, payload, context);
    }
    if (name === "retry_due") {
      requirePhase(state, ["retry-scheduled"], name);
      if (
        state.nextRetryAt === null ||
        atMs(context.at) < atMs(state.nextRetryAt)
      ) {
        throw new WorkflowError(
          "invalid-state",
          "retry_due arrived before the scheduled retry instant"
        );
      }
      const next: SupervisorMessageState = {
        ...state,
        deliveryStatus: "pending",
        events: appendEvent(state, "retry-due", context.at),
        nextRetryAt: null,
        phase: "routed",
      };
      return { state: next };
    }
    if (name === "claim") {
      requirePhase(state, ["routed", "escalated"], name);
      if (state.deliveryStatus !== "accepted") {
        throw new WorkflowError(
          "invalid-state",
          "SupervisorMessage cannot be claimed before delivery is accepted"
        );
      }
      const claimant = requireString(payload, "claimant", SUPERVISOR_ID_RE);
      if (claimant !== state.to) {
        throw new WorkflowError(
          "invalid-command",
          "only the intended supervisor may claim the message"
        );
      }
      const next: SupervisorMessageState = {
        ...state,
        claimedAt: context.at,
        claimedBy: claimant,
        events: appendEvent(state, "claimed", context.at),
        phase: "claimed",
      };
      return { state: next };
    }
    if (name === "acknowledge") {
      requirePhase(state, ["claimed"], name);
      const claimant = requireString(payload, "claimant", SUPERVISOR_ID_RE);
      if (claimant !== state.claimedBy) {
        throw new WorkflowError(
          "invalid-command",
          "only the current claimant may acknowledge the message"
        );
      }
      const next: SupervisorMessageState = {
        ...state,
        acknowledgedAt: context.at,
        events: appendEvent(state, "acknowledged", context.at),
        phase: "acknowledged",
      };
      return { state: next, status: "completed" };
    }
    if (name === "clock_tick") {
      return clockTick(state, context);
    }
    throw new WorkflowError(
      "unknown-signal",
      `unknown SupervisorMessage signal ${name}`
    );
  },

  start(input, context) {
    const message = parseInput(input);
    const state: SupervisorMessageState = {
      acknowledgedAt: null,
      artifactRefs: message.artifactRefs,
      body: message.body,
      canceledAt: null,
      claimBy: plusMs(context.at, message.policy.claimTimeoutMs),
      claimedAt: null,
      claimedBy: null,
      deadLetteredAt: null,
      dedupeKey: message.dedupeKey,
      deliveredAt: null,
      deliveryAttempts: 0,
      deliveryStatus: "pending",
      escalatedAt: null,
      escalationDeadline: null,
      events: [
        { at: message.receivedAt, kind: "received" },
        { at: context.at, kind: "persisted" },
        { at: context.at, kind: "routed" },
      ],
      from: message.from,
      lastFailure: null,
      messageId: message.messageId,
      nextRetryAt: null,
      phase: "routed",
      policy: message.policy,
      receivedAt: message.receivedAt,
      threadId: message.threadId,
      to: message.to,
    };
    return {
      result: projectionOf(state),
      state,
      status: terminalStatus(state.phase),
    };
  },

  type: SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
};

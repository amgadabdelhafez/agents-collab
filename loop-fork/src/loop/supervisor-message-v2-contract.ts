import { Sha256 } from "@aws-crypto/sha256-js";
import { SUPERVISOR_ID_RE } from "./supervisor-id";
import { supervisorMessageV2ScopedDigest } from "./supervisor-message-v2-workflow-identity";
import {
  parseSupervisorMessageInput,
  type SupervisorMessageInput,
  type SupervisorMessagePhase,
  type SupervisorMessagePolicy,
  type SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import type { JsonObject } from "./workflow-port";
import { WorkflowError } from "./workflow-port";

/**
 * V2 is deliberately a separate contract, not an optional field on V1. The
 * generic V1 workflow and its historical journals remain unchanged until a
 * separately authorized workflow migration can consume this shape.
 */
export const SUPERVISOR_MESSAGE_V2_SCHEMA = "supervisor-message.v2" as const;
export const SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA =
  "supervisor-message-replay-fixture.v2" as const;
/** Upper bound of a delivery attempt, and so of the delivery IDs per workflow. */
export const SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS = 20;

export interface TrustedSupervisorMessageV2Scope extends JsonObject {
  principal: string;
  tenantId: string;
}

export interface SupervisorMessageV2Input extends JsonObject {
  artifactRefs: string[];
  body: string;
  dedupeKey: string;
  from: string;
  messageId: string;
  policy: SupervisorMessagePolicy;
  principal: string;
  receivedAt: string;
  schema: typeof SUPERVISOR_MESSAGE_V2_SCHEMA;
  tenantId: string;
  threadId: string;
  to: string;
}

export interface SupervisorMessageV2ReplayFixture extends JsonObject {
  expectedScope: TrustedSupervisorMessageV2Scope;
  id: string;
  input: SupervisorMessageV2Input;
  schema: typeof SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA;
}

export interface SupervisorMessageV2Projection extends JsonObject {
  acknowledgedAt: null | string;
  actionRequired: SupervisorMessageProjection["actionRequired"];
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
  principal: string;
  receivedAt: string;
  schema: "supervisor-message-status.v2";
  tenantId: string;
  threadId: string;
  to: string;
}

export interface SupervisorMessageV2StateEvent extends JsonObject {
  at: string;
  kind: string;
}

/**
 * This is a replay/state codec only. It deliberately has no V1 workflow
 * adapter: a future V2 workflow must opt into this codec rather than casting a
 * tenant-less V1 state into it.
 */
export interface SupervisorMessageV2State extends JsonObject {
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
  events: SupervisorMessageV2StateEvent[];
  from: string;
  lastFailure: null | string;
  messageId: string;
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
  policy: SupervisorMessagePolicy;
  principal: string;
  receivedAt: string;
  schema: "supervisor-message-state.v2";
  tenantId: string;
  threadId: string;
  to: string;
}

export interface SupervisorMessageV2Identity extends JsonObject {
  boardItemId: string;
  deliveryId: string;
  receiptId: string;
  workflowId: string;
}

export interface SupervisorMessageV2DeliveryEnvelope extends JsonObject {
  artifactRefs: string[];
  body: string;
  deliveryAttempt: number;
  deliveryId: string;
  idempotencyKey: string;
  messageId: string;
  principal: string;
  schema: "supervisor-message-delivery.v2";
  target: string;
  tenantId: string;
  threadId: string;
  workflowId: string;
}

export type SupervisorMessageV2GovernedOperation =
  | "acknowledge"
  | "cancel"
  | "claim"
  | "receive"
  | "tick";

export interface SupervisorMessageV2GovernanceRequest extends JsonObject {
  claimant: null | string;
  from: string;
  operation: SupervisorMessageV2GovernedOperation;
  principal: string;
  schema: "supervisor-message-governance-request.v2";
  tenantId: string;
  threadId: string;
  to: string;
  workflowId: string;
}

export interface SupervisorMessageV2GovernanceReceipt extends JsonObject {
  at: string;
  authorityRef: string;
  claimant: null | string;
  decision: "allowed" | "denied";
  from: string;
  operation: SupervisorMessageV2GovernedOperation;
  principal: string;
  reasonCode: string;
  receiptId: string;
  schema: "supervisor-message-governance-receipt.v2";
  tenantId: string;
  threadId: string;
  to: string;
  workflowId: string;
}

export interface SupervisorMessageV2BoardItem extends JsonObject {
  acknowledgedAt: null | string;
  actionRequired: SupervisorMessageProjection["actionRequired"];
  artifactRefs: string[];
  boardItemId: string;
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
  principal: string;
  receivedAt: string;
  schema: "supervisor-message-board-item.v2";
  tenantId: string;
  threadId: string;
  to: string;
  workflowId: string;
}

const V2_INPUT_KEYS = [
  "artifactRefs",
  "body",
  "dedupeKey",
  "from",
  "messageId",
  "policy",
  "principal",
  "receivedAt",
  "schema",
  "tenantId",
  "threadId",
  "to",
] as const;

const V2_REPLAY_FIXTURE_KEYS = [
  "expectedScope",
  "id",
  "input",
  "schema",
] as const;
const V2_SCOPE_KEYS = ["principal", "tenantId"] as const;
const V2_PROJECTION_KEYS = [
  "acknowledgedAt",
  "actionRequired",
  "artifactRefs",
  "claimedAt",
  "claimedBy",
  "deadLetteredAt",
  "deliveredAt",
  "deliveryAttempts",
  "escalatedAt",
  "from",
  "messageId",
  "nextRetryAt",
  "phase",
  "principal",
  "receivedAt",
  "schema",
  "tenantId",
  "threadId",
  "to",
] as const;
const V2_STATE_KEYS = [
  "acknowledgedAt",
  "artifactRefs",
  "body",
  "canceledAt",
  "claimBy",
  "claimedAt",
  "claimedBy",
  "deadLetteredAt",
  "dedupeKey",
  "deliveredAt",
  "deliveryAttempts",
  "deliveryStatus",
  "escalatedAt",
  "escalationDeadline",
  "events",
  "from",
  "lastFailure",
  "messageId",
  "nextRetryAt",
  "phase",
  "policy",
  "principal",
  "receivedAt",
  "schema",
  "tenantId",
  "threadId",
  "to",
] as const;
const V2_DELIVERY_ENVELOPE_KEYS = [
  "artifactRefs",
  "body",
  "deliveryAttempt",
  "deliveryId",
  "idempotencyKey",
  "messageId",
  "principal",
  "schema",
  "target",
  "tenantId",
  "threadId",
  "workflowId",
] as const;
const V2_GOVERNANCE_REQUEST_KEYS = [
  "claimant",
  "from",
  "operation",
  "principal",
  "schema",
  "tenantId",
  "threadId",
  "to",
  "workflowId",
] as const;
const V2_GOVERNANCE_RECEIPT_KEYS = [
  "at",
  "authorityRef",
  "claimant",
  "decision",
  "from",
  "operation",
  "principal",
  "reasonCode",
  "receiptId",
  "schema",
  "tenantId",
  "threadId",
  "to",
  "workflowId",
] as const;
const V2_BOARD_ITEM_KEYS = [
  ...V2_PROJECTION_KEYS,
  "boardItemId",
  "workflowId",
] as const;
const POLICY_KEYS = [
  "claimTimeoutMs",
  "escalationTimeoutMs",
  "maxDeliveryAttempts",
  "retryDelayMs",
] as const;
const STATE_EVENT_KEYS = ["at", "kind"] as const;

const ACTION_RE = /^(acknowledge|claim|dead-letter|none|retry)$/;
const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ARTIFACT_REFS = 32;
const MAX_BODY_BYTES = 32_768;
const MAX_POLICY_MS = 30 * 24 * 60 * 60 * 1000;
const PHASE_RE =
  /^(acknowledged|canceled|claimed|dead-lettered|escalated|retry-scheduled|routed)$/;
const TENANT_ID_RE = /^tenant:[a-z0-9][a-z0-9._-]{0,127}$/;
const PRINCIPAL_RE = /^principal:[a-z0-9][a-z0-9._:-]{0,255}$/;
const FIXTURE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const DELIVERY_STATUS_RE = /^(accepted|pending|retry-scheduled)$/;
const EVENT_KIND_RE = /^[a-z][a-z0-9._:-]{0,255}$/;
const GOVERNANCE_OPERATION_RE = /^(acknowledge|cancel|claim|receive|tick)$/;
const GOVERNANCE_DECISION_RE = /^(allowed|denied)$/;
const V2_BOARD_ITEM_ID_RE = /^supervisor-message-board-item:v2:[a-f0-9]{64}$/;
const V2_DELIVERY_ID_RE = /^supervisor-message-delivery:v2:[a-f0-9]{64}$/;
const V2_RECEIPT_ID_RE = /^supervisor-message-receipt:v2:[a-f0-9]{64}$/;
/**
 * A V2 message workflow id in either format: the deployment-scoped
 * `supervisor-message-workflow:v2:deployment:<sha256>`, or the legacy
 * `supervisor-message-workflow:v2:<sha256>` that executions and ledger rows
 * created before the deployment discriminator carry, and that a ledger in
 * legacy-write mode still mints. Every id derived from a workflow id
 * (delivery, receipt, board item, result graph) accepts both, so a legacy
 * message keeps its derived ids unchanged.
 */
const V2_WORKFLOW_ID_RE =
  /^supervisor-message-workflow:v2:(?:deployment:)?[a-f0-9]{64}$/;
/**
 * The deployment discriminator: the Temporal task queue a host's worker polls
 * and its workflow port starts and adopts executions on (the same grammar as
 * the port's task queue).
 */
export const SUPERVISOR_MESSAGE_V2_DEPLOYMENT_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

const ACTION_FOR_PHASE: Readonly<
  Record<SupervisorMessagePhase, SupervisorMessageProjection["actionRequired"]>
> = {
  acknowledged: "none",
  canceled: "none",
  claimed: "acknowledge",
  "dead-lettered": "dead-letter",
  escalated: "claim",
  "retry-scheduled": "retry",
  routed: "claim",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
};

const requireString = (
  value: unknown,
  field: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 ${field} is invalid`
    );
  }
  return value;
};

const requireCanonicalUtc = (value: unknown, field: string): string => {
  const instant = requireString(value, field, CANONICAL_UTC_RE);
  const timestamp = Date.parse(instant);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== instant
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 ${field} is invalid`
    );
  }
  return instant;
};

const requireOptionalCanonicalUtc = (
  value: unknown,
  field: string
): null | string => (value === null ? null : requireCanonicalUtc(value, field));

const requireArtifactRefs = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARTIFACT_REFS ||
    value.some(
      (reference) =>
        typeof reference !== "string" || !ARTIFACT_REF_RE.test(reference)
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 projection artifactRefs are invalid"
    );
  }
  return [...value];
};

const requireNonNegativeSafeInteger = (
  value: unknown,
  field: string
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 projection ${field} is invalid`
    );
  }
  return Number(value);
};

const requireBoundedPositiveInteger = (
  value: unknown,
  field: string,
  maximum: number
): number => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) <= 0 ||
    Number(value) > maximum
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 ${field} is invalid`
    );
  }
  return Number(value);
};

const requirePolicy = (value: unknown): SupervisorMessagePolicy => {
  if (!(isRecord(value) && hasExactKeys(value, POLICY_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state policy fields are invalid"
    );
  }
  return {
    claimTimeoutMs: requireBoundedPositiveInteger(
      value.claimTimeoutMs,
      "policy claimTimeoutMs",
      MAX_POLICY_MS
    ),
    escalationTimeoutMs: requireBoundedPositiveInteger(
      value.escalationTimeoutMs,
      "policy escalationTimeoutMs",
      MAX_POLICY_MS
    ),
    maxDeliveryAttempts: requireBoundedPositiveInteger(
      value.maxDeliveryAttempts,
      "policy maxDeliveryAttempts",
      SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS
    ),
    retryDelayMs: requireBoundedPositiveInteger(
      value.retryDelayMs,
      "policy retryDelayMs",
      MAX_POLICY_MS
    ),
  };
};

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const requireStateEvents = (
  value: unknown,
  receivedAt: string
): SupervisorMessageV2StateEvent[] => {
  if (!Array.isArray(value) || value.length < 3) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state events are invalid"
    );
  }
  const events = value.map((event) => {
    if (!(isRecord(event) && hasExactKeys(event, STATE_EVENT_KEYS))) {
      throw new WorkflowError(
        "invalid-command",
        "SupervisorMessage V2 state event fields are invalid"
      );
    }
    return {
      at: requireCanonicalUtc(event.at, "state event at"),
      kind: requireString(event.kind, "state event kind", EVENT_KIND_RE),
    };
  });
  if (
    events[0]?.at !== receivedAt ||
    events[0]?.kind !== "received" ||
    !events.some((event) => event.kind === "persisted") ||
    !events.some((event) => event.kind === "routed")
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state events do not establish a routed message"
    );
  }
  for (let index = 1; index < events.length; index += 1) {
    const previousAt = events[index - 1]?.at;
    const currentAt = events[index]?.at;
    if (previousAt && currentAt && previousAt > currentAt) {
      throw new WorkflowError(
        "invalid-command",
        "SupervisorMessage V2 state events are not chronological"
      );
    }
  }
  return events;
};

const requireOptionalText = (value: unknown, field: string): null | string => {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    utf8ByteLength(value) > 512
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 ${field} is invalid`
    );
  }
  return value;
};

const requireBody = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    utf8ByteLength(value) > MAX_BODY_BYTES
  ) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 ${field} is invalid`
    );
  }
  return value;
};

const requireStateConsistency = (state: {
  acknowledgedAt: null | string;
  canceledAt: null | string;
  claimedAt: null | string;
  claimedBy: null | string;
  deadLetteredAt: null | string;
  deliveredAt: null | string;
  deliveryAttempts: number;
  deliveryStatus: SupervisorMessageV2State["deliveryStatus"];
  escalatedAt: null | string;
  escalationDeadline: null | string;
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
}): void => {
  requireStateDeliveryConsistency(state);
  requireStatePhaseConsistency(state);
};

const requireStateDeliveryConsistency = (state: {
  deliveredAt: null | string;
  deliveryAttempts: number;
  deliveryStatus: SupervisorMessageV2State["deliveryStatus"];
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
}): void => {
  if (state.deliveryStatus === "retry-scheduled") {
    if (state.phase !== "retry-scheduled" || state.nextRetryAt === null) {
      throw new WorkflowError(
        "invalid-command",
        "SupervisorMessage V2 retry state is inconsistent"
      );
    }
  } else if (state.nextRetryAt !== null || state.phase === "retry-scheduled") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 retry state is inconsistent"
    );
  }
  if (
    (state.deliveryStatus === "accepted") !== (state.deliveredAt !== null) ||
    (state.deliveredAt !== null && state.deliveryAttempts < 1)
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery state is inconsistent"
    );
  }
  if (state.deliveryAttempts === 0 && state.deliveryStatus !== "pending") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery attempts are inconsistent"
    );
  }
};

const requireStatePhaseConsistency = (state: {
  acknowledgedAt: null | string;
  canceledAt: null | string;
  claimedAt: null | string;
  claimedBy: null | string;
  deadLetteredAt: null | string;
  deliveryStatus: SupervisorMessageV2State["deliveryStatus"];
  escalatedAt: null | string;
  escalationDeadline: null | string;
  phase: SupervisorMessagePhase;
}): void => {
  const claimed = state.claimedAt !== null || state.claimedBy !== null;
  if ((state.claimedAt === null) !== (state.claimedBy === null)) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state claim fields are inconsistent"
    );
  }
  if (
    (state.phase === "claimed" || state.phase === "acknowledged") &&
    !(claimed && state.deliveryStatus === "accepted")
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 claimed state is inconsistent"
    );
  }
  if (
    (state.phase === "escalated" || state.escalatedAt !== null) &&
    !(
      state.phase === "escalated" &&
      state.deliveryStatus === "accepted" &&
      state.escalatedAt !== null &&
      state.escalationDeadline !== null
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 escalation state is inconsistent"
    );
  }
  if (state.escalatedAt === null && state.escalationDeadline !== null) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 escalation deadline is inconsistent"
    );
  }
  if ((state.phase === "acknowledged") !== (state.acknowledgedAt !== null)) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 acknowledgement state is inconsistent"
    );
  }
  if ((state.phase === "dead-lettered") !== (state.deadLetteredAt !== null)) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 dead-letter state is inconsistent"
    );
  }
  if ((state.phase === "canceled") !== (state.canceledAt !== null)) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 cancellation state is inconsistent"
    );
  }
  if (state.acknowledgedAt !== null && !claimed) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 acknowledgement lacks a claim"
    );
  }
};

const requireTrustedScope = (
  value: unknown
): TrustedSupervisorMessageV2Scope => ({
  principal: requireString(
    isRecord(value) ? value.principal : undefined,
    "trusted principal",
    PRINCIPAL_RE
  ),
  tenantId: requireString(
    isRecord(value) ? value.tenantId : undefined,
    "trusted tenant",
    TENANT_ID_RE
  ),
});

export const parseSupervisorMessageV2Scope = (
  value: unknown
): TrustedSupervisorMessageV2Scope => requireTrustedScope(value);

const scopedDigest = (
  scope: TrustedSupervisorMessageV2Scope,
  kind: string,
  values: readonly string[]
): string => {
  const trusted = requireTrustedScope(scope);
  return supervisorMessageV2ScopedDigest(
    trusted.tenantId,
    trusted.principal,
    kind,
    values
  );
};

export const parseSupervisorMessageV2Deployment = (value: unknown): string =>
  requireString(value, "deployment", SUPERVISOR_MESSAGE_V2_DEPLOYMENT_RE);

/**
 * The workflow id a host mints for a new message once its ledger writes the
 * deployment format: scoped to the tenant and principal, and to the
 * deployment, so two deployments sharing a Temporal namespace never derive
 * the same id for the same dedupe key.
 */
export const deriveSupervisorMessageV2WorkflowId = (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string,
  deployment: string
): string =>
  `supervisor-message-workflow:v2:deployment:${scopedDigest(
    scope,
    "workflow-deployment",
    [
      parseSupervisorMessageV2Deployment(deployment),
      requireString(dedupeKey, "dedupeKey", STABLE_ID_RE),
    ]
  )}`;

/**
 * The workflow id format before the deployment discriminator, byte for byte.
 * A ledger in legacy-write mode (the default until an operator opts in to the
 * deployment format) mints it for a new message, so a pre-discriminator build
 * can still be rolled back to. In deployment-write mode it is recognised only
 * for a message a ledger already recorded under it, so that message is still
 * recovered, acknowledged and deduplicated under the id its execution runs as.
 */
export const deriveSupervisorMessageV2LegacyWorkflowId = (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
): string =>
  `supervisor-message-workflow:v2:${scopedDigest(scope, "workflow", [
    requireString(dedupeKey, "dedupeKey", STABLE_ID_RE),
  ])}`;

/** The current, keyed result graph id (see `SupervisorResultGraphKey`). */
export const SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE =
  /^supervisor-result-graph:v3:[a-f0-9]{64}$/;

/** The retired unkeyed id. Bindings recorded under it before the key existed
 * stay publishable; no new binding may name one. */
export const SUPERVISOR_MESSAGE_V2_LEGACY_RESULT_GRAPH_WORKFLOW_ID_RE =
  /^supervisor-result-graph:v2:[a-f0-9]{64}$/;

const RESULT_GRAPH_KEY_MIN_BYTES = 32;
const keyEncoder = new TextEncoder();

/**
 * The host secret that keys result graph ids, read from an operator-named
 * environment variable. The bytes live only in a private field, so `String`,
 * `JSON.stringify` and `inspect` never render them.
 */
export class SupervisorResultGraphKey {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static fromSecret(secret: string): SupervisorResultGraphKey {
    const bytes = keyEncoder.encode(secret);
    if (bytes.byteLength < RESULT_GRAPH_KEY_MIN_BYTES) {
      throw new Error(
        `result graph key must be at least ${RESULT_GRAPH_KEY_MIN_BYTES} bytes`
      );
    }
    return new SupervisorResultGraphKey(bytes);
  }

  /** HMAC-SHA256 over length-prefixed, NUL-terminated fields. */
  mac(fields: readonly string[]): string {
    const hash = new Sha256(this.#bytes);
    for (const field of fields) {
      const encoded = keyEncoder.encode(field);
      hash.update(keyEncoder.encode(`${encoded.byteLength}:`));
      hash.update(encoded);
      hash.update(new Uint8Array([0]));
    }
    return [...hash.digestSync()]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * A short, non-reversible name for this key: `rgk:` and the first 16 hex
   * digits of an HMAC under the key over a fixed label. It identifies which
   * key a binding was derived under (in errors, logs and the assignment
   * listing) without revealing the key.
   */
  get fingerprint(): string {
    return `rgk:${this.mac(["supervisor-result-graph-key-fingerprint", "v1"]).slice(0, 16)}`;
  }
}

/** The format of `SupervisorResultGraphKey.fingerprint`. */
export const SUPERVISOR_RESULT_GRAPH_KEY_FINGERPRINT_RE = /^rgk:[a-f0-9]{16}$/;

/**
 * The one task graph whose tasks may carry this message's result. A
 * `task-graph.v1` carries no tenant or message identity, so the binding is
 * taken from the message instead: the graph workflow id is derived from the
 * message's scoped identity (tenant, principal, message workflow id).
 *
 * The derivation is keyed: HMAC-SHA256 under the host's result graph key
 * over ("supervisor-result-graph", "v3", tenant, principal, messageWorkflowId),
 * each field length-prefixed and NUL-terminated. Scope and message ids are
 * not secret, so without the key nobody can compute (and pre-start) another
 * message's graph. A graph named in a request body is accepted only when it
 * equals this id.
 */
export const deriveSupervisorMessageV2ResultGraphWorkflowId = (
  key: SupervisorResultGraphKey,
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): string => {
  const trusted = requireTrustedScope(scope);
  return `supervisor-result-graph:v3:${key.mac([
    "supervisor-result-graph",
    "v3",
    trusted.tenantId,
    trusted.principal,
    requireString(workflowId, "workflowId", V2_WORKFLOW_ID_RE),
  ])}`;
};

/**
 * The retired unkeyed derivation (2b1b1893): a plain scoped SHA-256 anyone
 * can compute. Kept only to recognise bindings recorded before the key: they
 * stay publishable, and no new binding may use one.
 */
export const deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): string =>
  `supervisor-result-graph:v2:${scopedDigest(scope, "result-graph", [
    requireString(workflowId, "workflowId", V2_WORKFLOW_ID_RE),
  ])}`;

export const deriveSupervisorMessageV2DeliveryId = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string,
  deliveryAttempt: number
): string =>
  `supervisor-message-delivery:v2:${scopedDigest(scope, "delivery", [
    requireString(workflowId, "workflowId", V2_WORKFLOW_ID_RE),
    String(
      requireBoundedPositiveInteger(
        deliveryAttempt,
        "deliveryAttempt",
        SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS
      )
    ),
  ])}`;

export const deriveSupervisorMessageV2ReceiptId = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string,
  operation: SupervisorMessageV2GovernedOperation,
  authorityRef: string,
  claimant: null | string
): string =>
  `supervisor-message-receipt:v2:${scopedDigest(scope, "receipt", [
    requireString(workflowId, "workflowId", V2_WORKFLOW_ID_RE),
    requireString(operation, "governance operation", GOVERNANCE_OPERATION_RE),
    requireString(authorityRef, "authorityRef", STABLE_ID_RE),
    claimant === null
      ? "claimant:none"
      : requireString(claimant, "governance claimant", SUPERVISOR_ID_RE),
  ])}`;

export const deriveSupervisorMessageV2BoardItemId = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): string =>
  `supervisor-message-board-item:v2:${scopedDigest(scope, "board-item", [
    requireString(workflowId, "workflowId", V2_WORKFLOW_ID_RE),
  ])}`;

export const deriveSupervisorMessageV2Identity = (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string,
  deliveryAttempt: number,
  operation: SupervisorMessageV2GovernedOperation,
  authorityRef: string,
  claimant: null | string,
  deployment: string
): SupervisorMessageV2Identity => {
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    scope,
    dedupeKey,
    deployment
  );
  return {
    boardItemId: deriveSupervisorMessageV2BoardItemId(scope, workflowId),
    deliveryId: deriveSupervisorMessageV2DeliveryId(
      scope,
      workflowId,
      deliveryAttempt
    ),
    receiptId: deriveSupervisorMessageV2ReceiptId(
      scope,
      workflowId,
      operation,
      authorityRef,
      claimant
    ),
    workflowId,
  };
};

const parseFixtureScope = (value: unknown): TrustedSupervisorMessageV2Scope => {
  if (!(isRecord(value) && hasExactKeys(value, V2_SCOPE_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 replay fixture expected scope fields are invalid"
    );
  }
  return requireTrustedScope({
    principal: value.principal as string,
    tenantId: value.tenantId as string,
  });
};

/**
 * Public scope parser for V2 control-plane adapters that have no message body
 * to parse.  It keeps tenant/principal validation in the canonical contract
 * rather than making storage or governance duplicate route syntax.
 */
export const parseTrustedSupervisorMessageV2Scope = (
  value: unknown
): TrustedSupervisorMessageV2Scope => requireTrustedScope(value);

const v1InputOf = (value: Record<string, unknown>): SupervisorMessageInput =>
  parseSupervisorMessageInput({
    artifactRefs: value.artifactRefs,
    body: value.body,
    dedupeKey: value.dedupeKey,
    from: value.from,
    messageId: value.messageId,
    policy: value.policy,
    receivedAt: value.receivedAt,
    threadId: value.threadId,
    to: value.to,
  } as JsonObject);

/**
 * Strictly parse a new V2 ingress record against its already authenticated
 * route scope. A raw wire message cannot choose a different tenant or
 * principal, and V1-shaped records never acquire a guessed tenant.
 */
export const parseSupervisorMessageV2Input = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2Input => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_INPUT_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 input fields do not match the canonical schema"
    );
  }
  if (value.schema !== SUPERVISOR_MESSAGE_V2_SCHEMA) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 input schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  if (tenantId !== trusted.tenantId || principal !== trusted.principal) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 input scope does not match the authenticated route"
    );
  }
  return {
    ...v1InputOf(value),
    principal,
    schema: SUPERVISOR_MESSAGE_V2_SCHEMA,
    tenantId,
  };
};

/**
 * Parse a persisted V2 state before replay. This is intentionally stricter
 * than a type assertion: state controls must be scope-bound, schema-exact,
 * and internally reachable from the V2 lifecycle before a worker can trust it.
 */
export const parseSupervisorMessageV2State = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2State => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_STATE_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-state.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  if (tenantId !== trusted.tenantId || principal !== trusted.principal) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 state scope does not match the authenticated route"
    );
  }
  const input = parseSupervisorMessageV2Input(
    {
      artifactRefs: value.artifactRefs,
      body: value.body,
      dedupeKey: value.dedupeKey,
      from: value.from,
      messageId: value.messageId,
      policy: value.policy,
      principal,
      receivedAt: value.receivedAt,
      schema: SUPERVISOR_MESSAGE_V2_SCHEMA,
      tenantId,
      threadId: value.threadId,
      to: value.to,
    },
    trusted
  );
  const phase = requireString(
    value.phase,
    "state phase",
    PHASE_RE
  ) as SupervisorMessagePhase;
  const deliveryStatus = requireString(
    value.deliveryStatus,
    "state deliveryStatus",
    DELIVERY_STATUS_RE
  ) as SupervisorMessageV2State["deliveryStatus"];
  const candidate = {
    acknowledgedAt: requireOptionalCanonicalUtc(
      value.acknowledgedAt,
      "state acknowledgedAt"
    ),
    artifactRefs: input.artifactRefs,
    body: input.body,
    canceledAt: requireOptionalCanonicalUtc(
      value.canceledAt,
      "state canceledAt"
    ),
    claimBy: requireCanonicalUtc(value.claimBy, "state claimBy"),
    claimedAt: requireOptionalCanonicalUtc(value.claimedAt, "state claimedAt"),
    claimedBy:
      value.claimedBy === null
        ? null
        : requireString(value.claimedBy, "state claimedBy", SUPERVISOR_ID_RE),
    deadLetteredAt: requireOptionalCanonicalUtc(
      value.deadLetteredAt,
      "state deadLetteredAt"
    ),
    dedupeKey: input.dedupeKey,
    deliveredAt: requireOptionalCanonicalUtc(
      value.deliveredAt,
      "state deliveredAt"
    ),
    deliveryAttempts: requireNonNegativeSafeInteger(
      value.deliveryAttempts,
      "state deliveryAttempts"
    ),
    deliveryStatus,
    escalatedAt: requireOptionalCanonicalUtc(
      value.escalatedAt,
      "state escalatedAt"
    ),
    escalationDeadline: requireOptionalCanonicalUtc(
      value.escalationDeadline,
      "state escalationDeadline"
    ),
    from: input.from,
    lastFailure: requireOptionalText(value.lastFailure, "state lastFailure"),
    messageId: input.messageId,
    nextRetryAt: requireOptionalCanonicalUtc(
      value.nextRetryAt,
      "state nextRetryAt"
    ),
    phase,
    policy: requirePolicy(value.policy),
    principal,
    receivedAt: input.receivedAt,
    tenantId,
    threadId: input.threadId,
    to: input.to,
  };
  requireStateConsistency(candidate);
  return {
    ...candidate,
    events: requireStateEvents(value.events, candidate.receivedAt),
    schema: "supervisor-message-state.v2",
  };
};

export const parseSupervisorMessageV2Projection = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2Projection => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_PROJECTION_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 projection fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-status.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 projection schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  if (tenantId !== trusted.tenantId || principal !== trusted.principal) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 projection scope does not match the authenticated route"
    );
  }
  const phase = requireString(
    value.phase,
    "projection phase",
    PHASE_RE
  ) as SupervisorMessagePhase;
  const actionRequired = requireString(
    value.actionRequired,
    "projection actionRequired",
    ACTION_RE
  ) as SupervisorMessageProjection["actionRequired"];
  if (actionRequired !== ACTION_FOR_PHASE[phase]) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 projection actionRequired conflicts with phase"
    );
  }
  return {
    acknowledgedAt: requireOptionalCanonicalUtc(
      value.acknowledgedAt,
      "projection acknowledgedAt"
    ),
    actionRequired,
    artifactRefs: requireArtifactRefs(value.artifactRefs),
    claimedAt: requireOptionalCanonicalUtc(
      value.claimedAt,
      "projection claimedAt"
    ),
    claimedBy:
      value.claimedBy === null
        ? null
        : requireString(
            value.claimedBy,
            "projection claimedBy",
            SUPERVISOR_ID_RE
          ),
    deadLetteredAt: requireOptionalCanonicalUtc(
      value.deadLetteredAt,
      "projection deadLetteredAt"
    ),
    deliveredAt: requireOptionalCanonicalUtc(
      value.deliveredAt,
      "projection deliveredAt"
    ),
    deliveryAttempts: requireNonNegativeSafeInteger(
      value.deliveryAttempts,
      "deliveryAttempts"
    ),
    escalatedAt: requireOptionalCanonicalUtc(
      value.escalatedAt,
      "projection escalatedAt"
    ),
    from: requireString(value.from, "projection from", SUPERVISOR_ID_RE),
    messageId: requireString(
      value.messageId,
      "projection messageId",
      STABLE_ID_RE
    ),
    nextRetryAt: requireOptionalCanonicalUtc(
      value.nextRetryAt,
      "projection nextRetryAt"
    ),
    phase,
    principal,
    receivedAt: requireCanonicalUtc(value.receivedAt, "projection receivedAt"),
    schema: "supervisor-message-status.v2",
    tenantId,
    threadId: requireString(
      value.threadId,
      "projection threadId",
      STABLE_ID_RE
    ),
    to: requireString(value.to, "projection to", SUPERVISOR_ID_RE),
  };
};

/** A delivery envelope cannot be replayed under another tenant or principal. */
export const parseSupervisorMessageV2DeliveryEnvelope = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2DeliveryEnvelope => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_DELIVERY_ENVELOPE_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-delivery.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  if (tenantId !== trusted.tenantId || principal !== trusted.principal) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery scope does not match the authenticated route"
    );
  }
  const workflowId = requireString(
    value.workflowId,
    "workflowId",
    V2_WORKFLOW_ID_RE
  );
  const deliveryAttempt = requireBoundedPositiveInteger(
    value.deliveryAttempt,
    "deliveryAttempt",
    SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS
  );
  const deliveryId = requireString(
    value.deliveryId,
    "deliveryId",
    V2_DELIVERY_ID_RE
  );
  const expectedDeliveryId = deriveSupervisorMessageV2DeliveryId(
    trusted,
    workflowId,
    deliveryAttempt
  );
  if (
    deliveryId !== expectedDeliveryId ||
    value.idempotencyKey !== deliveryId
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 delivery identity is inconsistent"
    );
  }
  return {
    artifactRefs: requireArtifactRefs(value.artifactRefs),
    body: requireBody(value.body, "delivery body"),
    deliveryAttempt,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: requireString(
      value.messageId,
      "delivery messageId",
      STABLE_ID_RE
    ),
    principal,
    schema: "supervisor-message-delivery.v2",
    target: requireString(value.target, "delivery target", SUPERVISOR_ID_RE),
    tenantId,
    threadId: requireString(value.threadId, "delivery threadId", STABLE_ID_RE),
    workflowId,
  };
};

export const parseSupervisorMessageV2GovernanceRequest = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2GovernanceRequest => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_GOVERNANCE_REQUEST_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance request fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-governance-request.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance request schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  if (tenantId !== trusted.tenantId || principal !== trusted.principal) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance request scope does not match the authenticated route"
    );
  }
  return {
    claimant:
      value.claimant === null
        ? null
        : requireString(
            value.claimant,
            "governance claimant",
            SUPERVISOR_ID_RE
          ),
    from: requireString(value.from, "governance from", SUPERVISOR_ID_RE),
    operation: requireString(
      value.operation,
      "governance operation",
      GOVERNANCE_OPERATION_RE
    ) as SupervisorMessageV2GovernedOperation,
    principal,
    schema: "supervisor-message-governance-request.v2",
    tenantId,
    threadId: requireString(
      value.threadId,
      "governance threadId",
      STABLE_ID_RE
    ),
    to: requireString(value.to, "governance to", SUPERVISOR_ID_RE),
    workflowId: requireString(
      value.workflowId,
      "workflowId",
      V2_WORKFLOW_ID_RE
    ),
  };
};

/**
 * Receipt parsing has an explicit request parameter so a receipt cannot be
 * replayed across operations, scopes, targets, or workflows.
 */
export const parseSupervisorMessageV2GovernanceReceipt = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope,
  requestValue: SupervisorMessageV2GovernanceRequest
): SupervisorMessageV2GovernanceReceipt => {
  const trusted = requireTrustedScope(trustedScope);
  const request = parseSupervisorMessageV2GovernanceRequest(
    requestValue,
    trusted
  );
  if (!(isRecord(value) && hasExactKeys(value, V2_GOVERNANCE_RECEIPT_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance receipt fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-governance-receipt.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance receipt schema is invalid"
    );
  }
  const tenantId = requireString(value.tenantId, "tenantId", TENANT_ID_RE);
  const principal = requireString(value.principal, "principal", PRINCIPAL_RE);
  const operation = requireString(
    value.operation,
    "governance operation",
    GOVERNANCE_OPERATION_RE
  ) as SupervisorMessageV2GovernedOperation;
  const authorityRef = requireString(
    value.authorityRef,
    "authorityRef",
    STABLE_ID_RE
  );
  if (
    tenantId !== trusted.tenantId ||
    principal !== trusted.principal ||
    tenantId !== request.tenantId ||
    principal !== request.principal ||
    operation !== request.operation ||
    value.claimant !== request.claimant ||
    value.from !== request.from ||
    value.threadId !== request.threadId ||
    value.to !== request.to ||
    value.workflowId !== request.workflowId
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance receipt does not correlate with its request"
    );
  }
  const receiptId = requireString(
    value.receiptId,
    "receiptId",
    V2_RECEIPT_ID_RE
  );
  if (
    receiptId !==
    deriveSupervisorMessageV2ReceiptId(
      trusted,
      request.workflowId,
      operation,
      authorityRef,
      request.claimant
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 governance receipt identity is inconsistent"
    );
  }
  return {
    at: requireCanonicalUtc(value.at, "governance receipt at"),
    authorityRef,
    claimant: request.claimant,
    decision: requireString(
      value.decision,
      "governance decision",
      GOVERNANCE_DECISION_RE
    ) as SupervisorMessageV2GovernanceReceipt["decision"],
    from: request.from,
    operation,
    principal,
    reasonCode: requireString(value.reasonCode, "reasonCode", STABLE_ID_RE),
    receiptId,
    schema: "supervisor-message-governance-receipt.v2",
    tenantId,
    threadId: request.threadId,
    to: request.to,
    workflowId: request.workflowId,
  };
};

export const parseSupervisorMessageV2BoardItem = (
  value: unknown,
  trustedScope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2BoardItem => {
  const trusted = requireTrustedScope(trustedScope);
  if (!(isRecord(value) && hasExactKeys(value, V2_BOARD_ITEM_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 board item fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-board-item.v2") {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 board item schema is invalid"
    );
  }
  const workflowId = requireString(
    value.workflowId,
    "workflowId",
    V2_WORKFLOW_ID_RE
  );
  const boardItemId = requireString(
    value.boardItemId,
    "boardItemId",
    V2_BOARD_ITEM_ID_RE
  );
  if (
    boardItemId !== deriveSupervisorMessageV2BoardItemId(trusted, workflowId)
  ) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 board item identity is inconsistent"
    );
  }
  const projection = parseSupervisorMessageV2Projection(
    {
      acknowledgedAt: value.acknowledgedAt,
      actionRequired: value.actionRequired,
      artifactRefs: value.artifactRefs,
      claimedAt: value.claimedAt,
      claimedBy: value.claimedBy,
      deadLetteredAt: value.deadLetteredAt,
      deliveredAt: value.deliveredAt,
      deliveryAttempts: value.deliveryAttempts,
      escalatedAt: value.escalatedAt,
      from: value.from,
      messageId: value.messageId,
      nextRetryAt: value.nextRetryAt,
      phase: value.phase,
      principal: value.principal,
      receivedAt: value.receivedAt,
      schema: "supervisor-message-status.v2",
      tenantId: value.tenantId,
      threadId: value.threadId,
      to: value.to,
    },
    trusted
  );
  return {
    ...projection,
    boardItemId,
    schema: "supervisor-message-board-item.v2",
    workflowId,
  };
};

export const parseSupervisorMessageV2ReplayFixture = (
  value: unknown
): SupervisorMessageV2ReplayFixture => {
  if (!(isRecord(value) && hasExactKeys(value, V2_REPLAY_FIXTURE_KEYS))) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 replay fixture fields do not match the canonical schema"
    );
  }
  if (value.schema !== SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA) {
    throw new WorkflowError(
      "invalid-command",
      "SupervisorMessage V2 replay fixture schema is invalid"
    );
  }
  const expectedScope = parseFixtureScope(value.expectedScope);
  return {
    expectedScope,
    id: requireString(value.id, "replay fixture id", FIXTURE_ID_RE),
    input: parseSupervisorMessageV2Input(value.input, expectedScope),
    schema: SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA,
  };
};

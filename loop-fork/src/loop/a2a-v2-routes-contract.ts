import { TaskState } from "@a2a-js/sdk";
import {
  parseSupervisorEndpointLocator,
  requireSupervisorEndpointHolderRef,
  requireSupervisorEndpointLeaseFence,
  requireSupervisorEndpointLeaseTtlMs,
  requireSupervisorEndpointRecipient,
  requireSupervisorEndpointSessionRef,
  type SupervisorEndpointKind,
  type SupervisorEndpointLeaseFenceRefusal,
  type SupervisorEndpointLeaseHolderSummary,
  type SupervisorEndpointLocator,
  supervisorEndpointSlug,
} from "./supervisor-endpoint-lease";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";

/**
 * r9 shared contract: the HTTP routes under the configured `a2aV2.routePath`
 * that T3 serves and T4 calls. Types, path helpers and strict request parsers
 * only; no handler.
 *
 * | method | path                                   | auth                         |
 * |--------|----------------------------------------|------------------------------|
 * | POST   | {routePath}/sessions/claim             | bearer, identity == body id  |
 * | POST   | {routePath}/sessions/renew             | bearer, identity == body id  |
 * | POST   | {routePath}/sessions/release           | bearer, identity == body id  |
 * | POST   | {routePath}/supervisors/<slug>         | bearer, any configured id    |
 * | GET    | {routePath}/messages/<messageId>       | bearer, sender principal     |
 *
 * - <slug> is the recipient id without its `supervisor:` prefix, so the
 *   segment is never read as a URL scheme. The ingress is the A2A JSON-RPC
 *   SDK transport, exactly as the existing primary and peer ingress: the
 *   message's `harness.dev/from` metadata must equal the authenticated
 *   supervisorId, the recipient is the path's supervisor, and grants still
 *   decide. No agent-card route is added: clients build the card locally with
 *   agentCardFor({supervisorId, url: <ingress URL>}) and
 *   ClientFactory.createFromAgentCard. Streaming and push stay false.
 * - messages/<messageId> answers only within {route tenant, authenticated
 *   principal}; any other message is 404, indistinguishable from absent.
 * - Errors use the existing envelope `{ error: { code } }` with the status of
 *   `A2A_V2_ROUTE_ERROR_STATUS`. A lease refusal adds `current` (held) or
 *   `reason` (fenced). No error carries a path, URL, token or driver detail.
 * - SECURITY: a claim's locator is untrusted ids ({repoId, runId, seat},
 *   {sessionId} or {repoId, runId, threadId}); the request carries no path
 *   or URL. The handler resolves it with the server's own resolver for the
 *   authenticated supervisorId (never a caller-chosen one), and refuses with
 *   `locator-refused` (403, no detail: whether a path exists, escapes the
 *   root, or names another supervisor is not disclosed). Renew re-resolves
 *   the stored locator the same way.
 * - `/a2a/v2` (the bare routePath) stays the r8 recipient ingress; the
 *   existing /seats/<seat>, /assignment, /result-graph and /recipient routes
 *   are unchanged. /healthz stays counts only.
 * - Acknowledgement stays on the existing recipient route (`loop a2a ack`,
 *   `loop mailbox ack` for V2 envelopes); nothing here acknowledges.
 */

export const A2A_V2_SESSION_OPERATIONS = ["claim", "renew", "release"] as const;
export type A2AV2SessionOperation = (typeof A2A_V2_SESSION_OPERATIONS)[number];

/** Sub-paths of routePath already served by r8; new routes must not collide. */
export const A2A_V2_EXISTING_SUBPATHS = [
  "/assignment",
  "/recipient",
  "/result-graph",
  "/seats/",
] as const;
export const A2A_V2_SESSIONS_SUBPATH = "/sessions/" as const;
export const A2A_V2_SUPERVISORS_SUBPATH = "/supervisors/" as const;
export const A2A_V2_MESSAGES_SUBPATH = "/messages/" as const;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const SUPERVISOR_PREFIX = "supervisor:";

export class A2AV2RouteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AV2RouteContractError";
  }
}

export const a2aV2SupervisorSlug = (supervisorId: string): string =>
  supervisorEndpointSlug(supervisorId);

export const a2aV2SupervisorIdFromSlug = (slug: string): string | undefined =>
  SLUG_RE.test(slug) ? `${SUPERVISOR_PREFIX}${slug}` : undefined;

export const a2aV2SessionRoutePath = (
  routePath: string,
  operation: A2AV2SessionOperation
): string => `${routePath}${A2A_V2_SESSIONS_SUBPATH}${operation}`;

export const a2aV2SupervisorIngressPath = (
  routePath: string,
  supervisorId: string
): string =>
  `${routePath}${A2A_V2_SUPERVISORS_SUBPATH}${a2aV2SupervisorSlug(supervisorId)}`;

export const a2aV2MessageStatusPath = (
  routePath: string,
  messageId: string
): string => {
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new A2AV2RouteContractError("messageId is invalid");
  }
  return `${routePath}${A2A_V2_MESSAGES_SUBPATH}${encodeURIComponent(messageId)}`;
};

export type A2AV2RouteMatch =
  | { method: "GET"; messageId: string; route: "message-status" }
  | { method: "POST"; operation: A2AV2SessionOperation; route: "session" }
  | { method: "POST"; route: "supervisor-ingress"; supervisorId: string };

/**
 * Exact match of a request pathname (as `new URL(request.url).pathname`) to
 * one r9 route: one segment after the sub-path, no trailing slash, no extra
 * segments. Undefined for anything else, including the r8 routes.
 */
export const matchA2AV2Route = (
  routePath: string,
  pathname: string
): A2AV2RouteMatch | undefined => {
  // The segment's own pattern (operation list, slug, message id) refuses an
  // empty segment, a trailing slash and any further segment.
  const tail = (subpath: string): string | undefined => {
    const prefix = `${routePath}${subpath}`;
    return pathname.startsWith(prefix)
      ? pathname.slice(prefix.length)
      : undefined;
  };
  const operation = tail(A2A_V2_SESSIONS_SUBPATH);
  if (operation !== undefined) {
    return (A2A_V2_SESSION_OPERATIONS as readonly string[]).includes(operation)
      ? {
          method: "POST",
          operation: operation as A2AV2SessionOperation,
          route: "session",
        }
      : undefined;
  }
  const slug = tail(A2A_V2_SUPERVISORS_SUBPATH);
  if (slug !== undefined) {
    const supervisorId = a2aV2SupervisorIdFromSlug(slug);
    return supervisorId
      ? { method: "POST", route: "supervisor-ingress", supervisorId }
      : undefined;
  }
  const encoded = tail(A2A_V2_MESSAGES_SUBPATH);
  if (encoded !== undefined) {
    let messageId: string;
    try {
      messageId = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    return MESSAGE_ID_RE.test(messageId)
      ? { messageId, method: "GET", route: "message-status" }
      : undefined;
  }
  return undefined;
};

export const A2A_V2_SESSION_REQUEST_SCHEMAS = {
  claim: "supervisor-endpoint-session-claim.v2",
  release: "supervisor-endpoint-session-release.v2",
  renew: "supervisor-endpoint-session-renew.v2",
} as const satisfies Record<A2AV2SessionOperation, string>;
export const A2A_V2_SESSION_RECEIPT_SCHEMA =
  "supervisor-endpoint-session-receipt.v2" as const;
export const A2A_V2_MESSAGE_STATUS_SCHEMA =
  "supervisor-message-sender-status.v2" as const;

export interface A2AV2SessionClaimRequest {
  holderRef: string;
  locator: SupervisorEndpointLocator;
  schema: typeof A2A_V2_SESSION_REQUEST_SCHEMAS.claim;
  sessionRef: string;
  /** Must equal the authenticated identity's supervisorId. */
  supervisorId: string;
  /** Operator `--takeover`: evict a live lease of another holder. */
  takeover?: boolean;
  /** Omitted: the server's a2aV2.sessionTtlMs. */
  ttlMs?: number;
}

export interface A2AV2SessionRenewRequest {
  epoch: number;
  holderRef: string;
  schema: typeof A2A_V2_SESSION_REQUEST_SCHEMAS.renew;
  supervisorId: string;
  ttlMs?: number;
}

export interface A2AV2SessionReleaseRequest {
  epoch: number;
  holderRef: string;
  schema: typeof A2A_V2_SESSION_REQUEST_SCHEMAS.release;
  supervisorId: string;
}

export interface A2AV2SessionRequestByOperation {
  claim: A2AV2SessionClaimRequest;
  release: A2AV2SessionReleaseRequest;
  renew: A2AV2SessionRenewRequest;
}

/** 200 body for every session operation. Body-free: no locator is echoed. */
export interface A2AV2SessionReceipt {
  /** release only: false for an idempotent repeat. */
  changed?: boolean;
  descriptorRevision: number;
  epoch: number;
  expiresAt: string;
  holderRef: string;
  kind: SupervisorEndpointKind;
  operation: A2AV2SessionOperation;
  releasedAt: null | string;
  schema: typeof A2A_V2_SESSION_RECEIPT_SCHEMA;
  supervisorId: string;
  /** claim only: true when a live lease of another holder was evicted. */
  tookOver?: boolean;
}

/** SDK TaskState by name, so the JSON does not depend on enum numbering. */
export type A2AV2TaskStateName = keyof typeof TaskState;

/** 200 body of GET {routePath}/messages/<messageId>. */
export interface A2AV2MessageStatusResponse {
  /** Recipient's delivery/read acknowledgement. Not completion. */
  acknowledgedAt: null | string;
  /** Provider (or mailbox) acceptance. Not acknowledgement. */
  deliveredAt: null | string;
  messageId: string;
  phase: SupervisorMessagePhase;
  schema: typeof A2A_V2_MESSAGE_STATUS_SCHEMA;
  /** Null until the SDK task exists. */
  taskState: A2AV2TaskStateName | null;
  to: string;
  /** True only when a result was published (SDK task COMPLETED). */
  workResultCompleted: boolean;
}

export const a2aV2TaskStateName = (
  state: TaskState | undefined
): A2AV2TaskStateName | null => {
  if (state === undefined) {
    return null;
  }
  const name = TaskState[state];
  return typeof name === "string" ? (name as A2AV2TaskStateName) : null;
};

export const a2aV2WorkResultCompleted = (
  taskState: A2AV2TaskStateName | null
): boolean => taskState === "TASK_STATE_COMPLETED";

export const A2A_V2_ROUTE_ERROR_STATUS = {
  "authentication-failed": 500,
  "body-too-large": 413,
  "content-type-invalid": 415,
  "identity-mismatch": 403,
  "lease-fenced": 409,
  "lease-held": 409,
  /** The locator did not resolve under the server's roots for this id. */
  "locator-refused": 403,
  "method-not-allowed": 405,
  "not-found": 404,
  "request-invalid": 400,
  unauthenticated: 401,
  /** V2 disabled by a fault, or the lease/ledger store cannot answer. */
  "v2-unavailable": 503,
} as const;
export type A2AV2RouteErrorCode = keyof typeof A2A_V2_ROUTE_ERROR_STATUS;

export type A2AV2RouteErrorBody =
  | {
      error: {
        code: "lease-held";
        current: SupervisorEndpointLeaseHolderSummary;
      };
    }
  | {
      error: {
        code: "lease-fenced";
        reason: SupervisorEndpointLeaseFenceRefusal;
      };
    }
  | {
      error: {
        code: Exclude<A2AV2RouteErrorCode, "lease-fenced" | "lease-held">;
      };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** No key outside `required` and `optional`; each required field's own
 * validator refuses it when absent. */
const keysWithin = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean =>
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key)
  );

const optionalTtl = (value: unknown): { ttlMs?: number } =>
  value === undefined
    ? {}
    : { ttlMs: requireSupervisorEndpointLeaseTtlMs(value) };

/**
 * Strict decode of a session request body, shared by the server (T3) and the
 * clients (T4). Unknown keys, a wrong schema, or an invalid field throw.
 * Identity binding (supervisorId == authenticated id) is the server's check.
 */
export const parseA2AV2SessionRequest = <O extends A2AV2SessionOperation>(
  operation: O,
  value: unknown
): A2AV2SessionRequestByOperation[O] => {
  if (
    !(
      isRecord(value) &&
      value.schema === A2A_V2_SESSION_REQUEST_SCHEMAS[operation]
    )
  ) {
    throw new A2AV2RouteContractError("session request schema is invalid");
  }
  try {
    const supervisorId = requireSupervisorEndpointRecipient(value.supervisorId);
    if (operation === "claim") {
      if (
        !(
          keysWithin(
            value,
            ["holderRef", "locator", "schema", "sessionRef", "supervisorId"],
            ["takeover", "ttlMs"]
          ) &&
          (value.takeover === undefined || typeof value.takeover === "boolean")
        )
      ) {
        throw new A2AV2RouteContractError("claim request is invalid");
      }
      const claim: A2AV2SessionClaimRequest = {
        holderRef: requireSupervisorEndpointHolderRef(value.holderRef),
        locator: parseSupervisorEndpointLocator(value.locator),
        schema: A2A_V2_SESSION_REQUEST_SCHEMAS.claim,
        sessionRef: requireSupervisorEndpointSessionRef(value.sessionRef),
        supervisorId,
        ...(value.takeover === undefined ? {} : { takeover: value.takeover }),
        ...optionalTtl(value.ttlMs),
      };
      return claim as A2AV2SessionRequestByOperation[O];
    }
    const optional = operation === "renew" ? ["ttlMs"] : [];
    if (
      !keysWithin(
        value,
        ["epoch", "holderRef", "schema", "supervisorId"],
        optional
      )
    ) {
      throw new A2AV2RouteContractError(`${operation} request is invalid`);
    }
    const fence = requireSupervisorEndpointLeaseFence(value);
    return {
      ...fence,
      schema: A2A_V2_SESSION_REQUEST_SCHEMAS[operation],
      supervisorId,
      ...(operation === "renew" ? optionalTtl(value.ttlMs) : {}),
    } as A2AV2SessionRequestByOperation[O];
  } catch (error) {
    if (error instanceof A2AV2RouteContractError) {
      throw error;
    }
    throw new A2AV2RouteContractError(`${operation} request is invalid`);
  }
};

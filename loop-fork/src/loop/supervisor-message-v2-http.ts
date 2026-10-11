import type {
  SupervisorA2AAuthenticatedIdentity,
  SupervisorA2AAuthenticator,
} from "./a2a-supervisor-http";
import { readBoundedRequestText } from "./bounded-request-body";
import {
  deriveSupervisorMessageV2DeliveryId,
  SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS,
  type SupervisorMessageV2Projection,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  type GovernedSupervisorMessageV2Service,
  SupervisorMessageV2GovernanceError,
} from "./supervisor-message-v2-governance";
import { SupervisorMessageV2RecipientTooEarlyError } from "./supervisor-message-v2-runtime";
import { WorkflowError } from "./workflow-port";

/** The host resolves the original workflow scope from a trusted assignment.
 * Neither the recipient's JSON nor its principal becomes the sender scope.
 */
export interface SupervisorMessageV2RecipientHttpOptions {
  authenticator: SupervisorA2AAuthenticator;
  governance: Pick<GovernedSupervisorMessageV2Service, "claim" | "acknowledge">;
  pathname: string;
  publishResult?(
    scope: TrustedSupervisorMessageV2Scope,
    input: { workflowId: string; taskId: string; recipient: string }
  ): Promise<void>;
  resolveAssignment(input: {
    identity: SupervisorA2AAuthenticatedIdentity;
    workflowId: string;
  }): Promise<TrustedSupervisorMessageV2Scope | undefined>;
}

const response = (status: number, code: string): Response =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;

const parseCommand = (
  raw: string
):
  | {
      operation: "claim" | "acknowledge" | "publish-result";
      taskId?: string;
      requestId: string;
      workflowId: string;
    }
  | undefined => {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      (value.operation === "publish-result"
        ? "operation,requestId,taskId,workflowId"
        : "operation,requestId,workflowId") ||
    (value.operation !== "claim" &&
      value.operation !== "acknowledge" &&
      value.operation !== "publish-result") ||
    typeof value.workflowId !== "string" ||
    !reference.test(value.workflowId) ||
    typeof value.requestId !== "string" ||
    !reference.test(value.requestId)
  ) {
    return undefined;
  }
  if (
    value.operation === "publish-result" &&
    (typeof value.taskId !== "string" || !reference.test(value.taskId))
  ) {
    return undefined;
  }
  return {
    operation: value.operation,
    requestId: value.requestId,
    workflowId: value.workflowId,
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
  };
};

const publishHttpResult = async (
  options: SupervisorMessageV2RecipientHttpOptions,
  identity: SupervisorA2AAuthenticatedIdentity,
  command: NonNullable<ReturnType<typeof parseCommand>>
): Promise<Response> => {
  const trustedScope = await options.resolveAssignment({
    identity,
    workflowId: command.workflowId,
  });
  if (!trustedScope) {
    return response(403, "assignment-denied");
  }
  if (!(options.publishResult && command.taskId)) {
    return response(409, "result-publication-unavailable");
  }
  try {
    await options.publishResult(trustedScope, {
      workflowId: command.workflowId,
      taskId: command.taskId,
      recipient: identity.supervisorId,
    });
  } catch {
    return response(409, "lifecycle-command-refused");
  }
  return Response.json(
    {
      schema: "supervisor-work-result-receipt.v1",
      workflowId: command.workflowId,
      taskId: command.taskId,
      resultPublished: true,
    },
    { headers: { "cache-control": "no-store" } }
  );
};

export const createSupervisorMessageV2RecipientHttpHandler =
  (
    options: SupervisorMessageV2RecipientHttpOptions
  ): ((request: Request) => Promise<Response>) =>
  async (request) => {
    if (new URL(request.url).pathname !== options.pathname) {
      return response(404, "not-found");
    }
    if (request.method !== "POST") {
      return response(405, "method-not-allowed");
    }
    const identity = await options.authenticator.authenticate(request);
    if (
      !(
        identity &&
        reference.test(identity.principal) &&
        reference.test(identity.supervisorId)
      )
    ) {
      return response(401, "unauthenticated");
    }
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      return response(415, "json-required");
    }
    const raw = await readBoundedRequestText(request, 8192);
    if (raw === undefined) {
      return response(413, "body-too-large");
    }
    const command = parseCommand(raw);
    if (!command) {
      return response(400, "invalid-command");
    }
    if (command.operation === "publish-result") {
      return await publishHttpResult(options, identity, command);
    }
    return lifecycleResponse(
      command.workflowId,
      await runSupervisorMessageV2RecipientLifecycle(options, identity, {
        operation: command.operation,
        requestId: command.requestId,
        workflowId: command.workflowId,
      })
    );
  };

/** A recipient's claim or acknowledge, before any transport. */
export interface SupervisorMessageV2RecipientLifecycleCommand {
  /**
   * In-process callers only (never parsed from a request body): the delivery
   * key the recipient's own mailbox reader recorded for this message. When
   * present, the command is refused unless the key is one this workflow's
   * delivery issued (an attempt's id under the message's own scope), so a
   * mailbox cursor speaks only for the message it actually received.
   */
  deliveryKey?: string;
  operation: "acknowledge" | "claim";
  requestId: string;
  workflowId: string;
}

/**
 * The recipient route's verdict on one lifecycle command. `transient` marks a
 * refusal whose cause was not the workflow's or the authority's decision (a
 * store or engine error): the HTTP answer is the same opaque code either way,
 * and only an in-process caller may use it to decide whether to retry.
 */
export type SupervisorMessageV2RecipientLifecycleOutcome =
  | {
      kind: "receipt";
      projection: Pick<
        SupervisorMessageV2Projection,
        "acknowledgedAt" | "claimedAt" | "phase"
      >;
    }
  | { code: "assignment-denied"; kind: "refused" }
  | {
      code: "delivery-not-recorded" | "not-claimed";
      kind: "refused";
      retryAt: null | string;
    }
  | {
      code: "lifecycle-command-refused";
      kind: "refused";
      transient: boolean;
    };

/** Whether `key` is the id of one of this workflow's delivery attempts. */
const isIssuedDeliveryKey = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string,
  key: string
): boolean => {
  try {
    for (
      let attempt = 1;
      attempt <= SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS;
      attempt++
    ) {
      if (
        deriveSupervisorMessageV2DeliveryId(scope, workflowId, attempt) === key
      ) {
        return true;
      }
    }
  } catch {
    // A workflow id or scope the derivation refuses issued no key.
  }
  return false;
};

/**
 * The recipient route's own claim/acknowledge logic for an identity the
 * caller has already established: the authenticated bearer for the HTTP
 * route or, in-process, the configured identity of the supervisor whose own
 * mailbox reader acknowledged the message. The assignment is resolved from
 * that identity (never from the command), and the claimant is always the
 * identity's own supervisor id. A store error resolving the assignment
 * propagates, as it does on the HTTP route.
 */
export const runSupervisorMessageV2RecipientLifecycle = async (
  options: Pick<
    SupervisorMessageV2RecipientHttpOptions,
    "governance" | "resolveAssignment"
  >,
  identity: SupervisorA2AAuthenticatedIdentity,
  command: SupervisorMessageV2RecipientLifecycleCommand
): Promise<SupervisorMessageV2RecipientLifecycleOutcome> => {
  const trustedScope = await options.resolveAssignment({
    identity,
    workflowId: command.workflowId,
  });
  if (!trustedScope) {
    return { code: "assignment-denied", kind: "refused" };
  }
  if (
    command.deliveryKey !== undefined &&
    !isIssuedDeliveryKey(trustedScope, command.workflowId, command.deliveryKey)
  ) {
    // Answered as an unassigned message: nothing more is disclosed.
    return { code: "assignment-denied", kind: "refused" };
  }
  try {
    const projection = await options.governance[command.operation]({
      claimant: identity.supervisorId,
      requestId: command.requestId,
      trustedScope,
      workflowId: command.workflowId,
    });
    return {
      kind: "receipt",
      projection: {
        acknowledgedAt: projection.acknowledgedAt,
        claimedAt: projection.claimedAt,
        phase: projection.phase,
      },
    };
  } catch (error) {
    if (error instanceof SupervisorMessageV2RecipientTooEarlyError) {
      return { code: error.reason, kind: "refused", retryAt: error.retryAt };
    }
    return {
      code: "lifecycle-command-refused",
      kind: "refused",
      transient: !(
        error instanceof WorkflowError ||
        error instanceof SupervisorMessageV2GovernanceError
      ),
    };
  }
};

/**
 * A claim or acknowledge as the HTTP route answers it. A refusal: the
 * intended recipient (it passed the assignment) that is early, its delivery
 * or claim not recorded yet, is told so, and when the retry can pass: nothing
 * was signalled, so the same command succeeds once it is. Anything else stays
 * the one opaque code.
 */
const lifecycleResponse = (
  workflowId: string,
  outcome: SupervisorMessageV2RecipientLifecycleOutcome
): Response => {
  if (outcome.kind === "receipt") {
    return Response.json(
      {
        schema: "supervisor-message-recipient-receipt.v2",
        workflowId,
        phase: outcome.projection.phase,
        claimedAt: outcome.projection.claimedAt,
        acknowledgedAt: outcome.projection.acknowledgedAt,
        workResultCompleted: false,
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
  if (outcome.code === "assignment-denied") {
    return response(403, "assignment-denied");
  }
  if (outcome.code === "lifecycle-command-refused") {
    return response(409, "lifecycle-command-refused");
  }
  const retryAt =
    outcome.retryAt === null ? Number.NaN : Date.parse(outcome.retryAt);
  return Response.json(
    {
      code: outcome.code,
      ...(Number.isFinite(retryAt)
        ? { retryAfterMs: Math.max(0, retryAt - Date.now()) }
        : {}),
    },
    { status: 409, headers: { "cache-control": "no-store" } }
  );
};

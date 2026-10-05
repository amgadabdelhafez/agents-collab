import type {
  SupervisorA2AAuthenticatedIdentity,
  SupervisorA2AAuthenticator,
} from "./a2a-supervisor-http";
import { readBoundedRequestText } from "./bounded-request-body";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import type { GovernedSupervisorMessageV2Service } from "./supervisor-message-v2-governance";

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
  trustedScope: TrustedSupervisorMessageV2Scope,
  command: NonNullable<ReturnType<typeof parseCommand>>,
  recipient: string
): Promise<Response> => {
  if (!(options.publishResult && command.taskId)) {
    return response(409, "result-publication-unavailable");
  }
  await options.publishResult(trustedScope, {
    workflowId: command.workflowId,
    taskId: command.taskId,
    recipient,
  });
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
    const trustedScope = await options.resolveAssignment({
      identity,
      workflowId: command.workflowId,
    });
    if (!trustedScope) {
      return response(403, "assignment-denied");
    }
    try {
      if (command.operation === "publish-result") {
        return await publishHttpResult(
          options,
          trustedScope,
          command,
          identity.supervisorId
        );
      }
      const projection = await options.governance[command.operation]({
        claimant: identity.supervisorId,
        requestId: command.requestId,
        trustedScope,
        workflowId: command.workflowId,
      });
      return Response.json(
        {
          schema: "supervisor-message-recipient-receipt.v2",
          workflowId: command.workflowId,
          phase: projection.phase,
          claimedAt: projection.claimedAt,
          acknowledgedAt: projection.acknowledgedAt,
          workResultCompleted: false,
        },
        { headers: { "cache-control": "no-store" } }
      );
    } catch {
      return response(409, "lifecycle-command-refused");
    }
  };

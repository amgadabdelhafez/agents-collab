import type { SupervisorA2AAuthenticator } from "./a2a-supervisor-http";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";

const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;
const fields = [
  "a2aTaskId",
  "graphTaskId",
  "graphWorkflowId",
  "messageWorkflowId",
  "recipient",
];
const reply = (status: number, code: string) =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });

/** Authenticated supervisor-only assignment. Sender scope is route-owned;
 * the durable service verifies task/message/recipient before recording it. */
export const createSupervisorA2AAssignmentHttpHandler =
  (options: {
    authenticator: SupervisorA2AAuthenticator;
    pathname: string;
    principal: string;
    tenant: string;
    bind(
      scope: TrustedSupervisorMessageV2Scope,
      binding: SupervisorA2AResultBinding
    ): Promise<void>;
  }) =>
  async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== options.pathname) {
      return reply(404, "not-found");
    }
    if (request.method !== "POST") {
      return reply(405, "method-not-allowed");
    }
    const identity = await options.authenticator.authenticate(request);
    if (!identity) {
      return reply(401, "unauthenticated");
    }
    if (identity.principal !== options.principal) {
      return reply(403, "control-principal-required");
    }
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      return reply(415, "json-required");
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) {
      return reply(413, "body-too-large");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return reply(400, "invalid-binding");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== fields.join(",") ||
      Object.values(value).some(
        (entry) => typeof entry !== "string" || !reference.test(entry)
      )
    ) {
      return reply(400, "invalid-binding");
    }
    try {
      const binding = value as SupervisorA2AResultBinding;
      await options.bind(
        { tenantId: options.tenant, principal: identity.principal },
        binding
      );
      return Response.json(
        {
          schema: "supervisor-result-assignment-receipt.v1",
          messageWorkflowId: binding.messageWorkflowId,
          a2aTaskId: binding.a2aTaskId,
          assigned: true,
        },
        { headers: { "cache-control": "no-store" } }
      );
    } catch {
      return reply(409, "assignment-refused");
    }
  };

import type { SupervisorA2AAuthenticator } from "./a2a-supervisor-http";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import { readBoundedRequestText } from "./bounded-request-body";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import type { SupervisorMessageV2UnpublishableResultBinding } from "./supervisor-message-v2-delivery-ledger";
import type { JsonObject, WorkflowStartReceipt } from "./workflow-port";

const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;
const fields = [
  "a2aTaskId",
  "graphTaskId",
  "graphWorkflowId",
  "messageWorkflowId",
  "recipient",
];
const START_FIELDS = "input,messageWorkflowId,requestId";
const MAX_GRAPH_START_BYTES = 64 * 1024;
const reply = (status: number, code: string) =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shared gate: authenticated control principal only. The route owns the
 * tenant; the body never chooses a scope. */
const authorize = async (
  options: {
    authenticator: SupervisorA2AAuthenticator;
    principal: string;
    tenant: string;
  },
  request: Request
): Promise<Response | TrustedSupervisorMessageV2Scope> => {
  const identity = await options.authenticator.authenticate(request);
  if (!identity) {
    return reply(401, "unauthenticated");
  }
  if (identity.principal !== options.principal) {
    return reply(403, "control-principal-required");
  }
  return { tenantId: options.tenant, principal: identity.principal };
};

const readJsonBody = async (
  request: Request,
  limit: number,
  invalid: string
): Promise<Response | { value: unknown }> => {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    return reply(415, "json-required");
  }
  const raw = await readBoundedRequestText(request, limit);
  if (raw === undefined) {
    return reply(413, "body-too-large");
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return reply(400, invalid);
  }
};

const listUnpublishable = async (
  scope: TrustedSupervisorMessageV2Scope,
  list: (
    scope: TrustedSupervisorMessageV2Scope
  ) => Promise<readonly SupervisorMessageV2UnpublishableResultBinding[]>
): Promise<Response> => {
  try {
    const entries = await list(scope);
    return Response.json(
      {
        schema: "supervisor-result-assignment-status.v1",
        unpublishable: entries.map(
          ({ tenantId: _tenantId, ...entry }) => entry
        ),
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return reply(503, "status-unavailable");
  }
};

/** Authenticated supervisor-only assignment. Sender scope is route-owned.
 * The body's graphWorkflowId is not trusted: the durable service refuses it
 * unless it equals the graph derived, under the host's result graph key,
 * from the message's scoped identity
 * (`deriveSupervisorMessageV2ResultGraphWorkflowId`). The body only chooses
 * the graph task inside that graph, which the service checks against its
 * host allowlist, task/message/recipient and the graph, and reserves for
 * this A2A task before recording it.
 *
 * GET on the same path is the inspection surface: the recorded bindings of
 * this route's tenant that will never publish (ids only). */
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
    unpublishable?(
      scope: TrustedSupervisorMessageV2Scope
    ): Promise<readonly SupervisorMessageV2UnpublishableResultBinding[]>;
  }) =>
  async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== options.pathname) {
      return reply(404, "not-found");
    }
    if (
      request.method !== "POST" &&
      !(request.method === "GET" && options.unpublishable)
    ) {
      return reply(405, "method-not-allowed");
    }
    const scope = await authorize(options, request);
    if (scope instanceof Response) {
      return scope;
    }
    if (request.method === "GET" && options.unpublishable) {
      return listUnpublishable(scope, options.unpublishable);
    }
    const body = await readJsonBody(request, 8192, "invalid-binding");
    if (body instanceof Response) {
      return body;
    }
    const value = body.value;
    if (
      !isObject(value) ||
      Object.keys(value).sort().join(",") !== fields.join(",") ||
      Object.values(value).some(
        (entry) => typeof entry !== "string" || !reference.test(entry)
      )
    ) {
      return reply(400, "invalid-binding");
    }
    try {
      const binding = value as unknown as SupervisorA2AResultBinding;
      await options.bind(scope, binding);
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

/**
 * Authenticated supervisor-only start of a message's result graph. The body
 * names the message and the `task-graph.v1` input; the graph workflow id is
 * never taken from the body. The service derives it under the host's result
 * graph key, so the caller needs no key and cannot choose another message's
 * graph. The response returns the derived id for the later assignment.
 */
export const createSupervisorA2AResultGraphStartHttpHandler =
  (options: {
    authenticator: SupervisorA2AAuthenticator;
    pathname: string;
    principal: string;
    tenant: string;
    start(
      scope: TrustedSupervisorMessageV2Scope,
      command: {
        input: JsonObject;
        messageWorkflowId: string;
        requestId: string;
      }
    ): Promise<{ graphWorkflowId: string; receipt: WorkflowStartReceipt }>;
  }) =>
  async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== options.pathname) {
      return reply(404, "not-found");
    }
    if (request.method !== "POST") {
      return reply(405, "method-not-allowed");
    }
    const scope = await authorize(options, request);
    if (scope instanceof Response) {
      return scope;
    }
    const body = await readJsonBody(
      request,
      MAX_GRAPH_START_BYTES,
      "invalid-result-graph-start"
    );
    if (body instanceof Response) {
      return body;
    }
    const value = body.value;
    if (
      !isObject(value) ||
      Object.keys(value).sort().join(",") !== START_FIELDS ||
      !isObject(value.input) ||
      typeof value.messageWorkflowId !== "string" ||
      !reference.test(value.messageWorkflowId) ||
      typeof value.requestId !== "string" ||
      !reference.test(value.requestId)
    ) {
      return reply(400, "invalid-result-graph-start");
    }
    try {
      const started = await options.start(scope, {
        input: value.input as JsonObject,
        messageWorkflowId: value.messageWorkflowId,
        requestId: value.requestId,
      });
      return Response.json(
        {
          schema: "supervisor-result-graph-start-receipt.v1",
          messageWorkflowId: value.messageWorkflowId,
          graphWorkflowId: started.graphWorkflowId,
          created: started.receipt.created,
        },
        { headers: { "cache-control": "no-store" } }
      );
    } catch {
      return reply(409, "result-graph-start-refused");
    }
  };

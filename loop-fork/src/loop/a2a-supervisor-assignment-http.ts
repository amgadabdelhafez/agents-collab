import type { SupervisorA2AAuthenticator } from "./a2a-supervisor-http";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import { readBoundedRequestText } from "./bounded-request-body";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import {
  RESULT_GRAPH_UNDER_PREVIOUS_KEY_ERROR,
  type SupervisorMessageV2PreviousKeyResultBinding,
  type SupervisorMessageV2RecoveryQuarantineEntry,
  type SupervisorMessageV2UnpublishableResultBinding,
} from "./supervisor-message-v2-delivery-ledger";
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

/** A graph started under a key that is now a previous key gets its own code:
 * the client must start the message's result graph again. No code names a
 * key; every other refusal stays generic. */
const assignmentRefusalCode = (error: unknown): string =>
  error instanceof Error && error.name === RESULT_GRAPH_UNDER_PREVIOUS_KEY_ERROR
    ? "result-graph-under-previous-key"
    : "assignment-refused";

/**
 * Per-seat delivery detail that the unauthenticated /healthz reports only as
 * counts: the host's seats that are not enrolled now, and the recipients a
 * session readiness-store outage currently defers. Seat ids only.
 */
export interface SupervisorA2AAssignmentDeliveryStatus {
  notEnrolled: readonly string[];
  readinessOutage: readonly string[];
}

interface AssignmentStatusLists {
  deliveryStatus?(): SupervisorA2AAssignmentDeliveryStatus;
  recoveryQuarantine?(
    scope: TrustedSupervisorMessageV2Scope
  ): Promise<readonly SupervisorMessageV2RecoveryQuarantineEntry[]>;
  /** This tenant's unsettled bindings derived under a previous result graph
   * key of this host's deployment. */
  underPreviousKey?(
    scope: TrustedSupervisorMessageV2Scope
  ): Promise<readonly SupervisorMessageV2PreviousKeyResultBinding[]>;
  unpublishable?(
    scope: TrustedSupervisorMessageV2Scope
  ): Promise<readonly SupervisorMessageV2UnpublishableResultBinding[]>;
}

/** The authenticated status body: each section the route has, ids only, for
 * the route's tenant (whose id is not repeated). */
const listStatus = async (
  scope: TrustedSupervisorMessageV2Scope,
  lists: AssignmentStatusLists
): Promise<Response> => {
  try {
    const unpublishable = await lists.unpublishable?.(scope);
    const previous = await lists.underPreviousKey?.(scope);
    const quarantined = await lists.recoveryQuarantine?.(scope);
    const delivery = lists.deliveryStatus?.();
    return Response.json(
      {
        ...(delivery
          ? {
              notEnrolled: [...delivery.notEnrolled],
              readinessOutage: [...delivery.readinessOutage],
            }
          : {}),
        ...(quarantined
          ? {
              recoveryQuarantine: quarantined.map(
                ({ tenantId: _tenantId, ...entry }) => entry
              ),
            }
          : {}),
        schema: "supervisor-result-assignment-status.v1",
        // Additive: this deployment's bindings that have not published yet
        // under a previous result graph key, named by fingerprint. A key no
        // entry names any more is no longer needed by this tenant.
        ...(previous
          ? {
              underPreviousResultGraphKey: previous.map(
                ({ tenantId: _tenantId, ...entry }) => entry
              ),
            }
          : {}),
        ...(unpublishable
          ? {
              unpublishable: unpublishable.map(
                ({ tenantId: _tenantId, ...entry }) => entry
              ),
            }
          : {}),
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
 * GET on the same path is the inspection surface, for the authenticated
 * control principal only: the recorded bindings of this route's tenant that
 * will never publish, those of this host's deployment that have not
 * published yet under a previous result graph key (ids and key fingerprints
 * only), its recorded starts an operator quarantined from recovery (ids,
 * recipient, who, when and why), and the host's per-seat delivery status
 * (ids only). Each section is present only when the host provides it:
 * `unpublishable`, `underPreviousResultGraphKey` and `recoveryQuarantine`
 * need a ledger that can list them (the PostgreSQL ledger can), `notEnrolled`
 * and `readinessOutage` need the delivery status. With none, GET is 405. */
export const createSupervisorA2AAssignmentHttpHandler =
  (
    options: AssignmentStatusLists & {
      authenticator: SupervisorA2AAuthenticator;
      pathname: string;
      principal: string;
      tenant: string;
      bind(
        scope: TrustedSupervisorMessageV2Scope,
        binding: SupervisorA2AResultBinding
      ): Promise<void>;
    }
  ) =>
  async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== options.pathname) {
      return reply(404, "not-found");
    }
    const inspectable = Boolean(
      options.unpublishable ||
        options.recoveryQuarantine ||
        options.deliveryStatus
    );
    if (
      request.method !== "POST" &&
      !(request.method === "GET" && inspectable)
    ) {
      return reply(405, "method-not-allowed");
    }
    const scope = await authorize(options, request);
    if (scope instanceof Response) {
      return scope;
    }
    if (request.method === "GET" && inspectable) {
      return listStatus(scope, options);
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
    } catch (error) {
      return reply(409, assignmentRefusalCode(error));
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

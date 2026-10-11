import { readBoundedRequestText } from "./bounded-request-body";
import {
  OWNER_REPLY_ONLY,
  ownerReplyOnlyResponse,
} from "./orchestration-owner-messaging";
import { SUPERVISOR_ID_RE } from "./supervisor-id";
import { SupervisorMessageGovernanceError } from "./supervisor-message-governance";
import type {
  SupervisorMessageReceiveCommand,
  SupervisorOrchestrationRuntime,
} from "./supervisor-orchestration-runtime";
import type { SupervisorThreadMessageKind } from "./supervisor-thread-store";
import type { TaskGraphRuntime } from "./task-graph-runtime";
import { WorkflowError } from "./workflow-port";

export interface SupervisorControlSurfaceIdentity {
  principal: string;
  supervisorId: string;
}

export interface SupervisorControlSurfaceAuthenticator {
  authenticate(
    request: Request
  ):
    | Promise<SupervisorControlSurfaceIdentity | undefined>
    | SupervisorControlSurfaceIdentity
    | undefined;
}

export interface SupervisorOrchestrationHttpOptions {
  authenticator: SupervisorControlSurfaceAuthenticator;
  messages: SupervisorOrchestrationRuntime;
  /**
   * RA2: the configured address a receive's `input.to` names (a role id that
   * aliases a configured legacy address routes to that address). Absent: the
   * recipient is used as sent.
   */
  resolveRecipient?: (recipient: string) => string;
  /**
   * The A2A V2 route that starts a message's result graph
   * (`<routePath>/result-graph`), when this server has one. It is only named
   * in the refusal of a reserved result graph id, so an operator script that
   * still calls `task-graphs/start` learns which route replaces that call.
   */
  resultGraphRoutePath?: string;
  tasks: TaskGraphRuntime;
}

const API_PREFIX = "/api/v1";
const MAX_BODY_BYTES = 64 * 1024;
const PRINCIPAL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const WORKFLOW_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const MESSAGE_KIND_RE =
  /^(authority-decision|conflict|failure|informational|question)$/;
const GRAPH_QUERY_RE = /^\/api\/v1\/task-graphs\/([^/]+)\/(ready|status)$/;
const RESULT_GRAPH_ID_PREFIX = "supervisor-result-graph:";

const json = (status: number, value: unknown): Response =>
  Response.json(value, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const errorResponse = (status: number, code: string): Response =>
  json(status, { error: { code } });

const RESULT_GRAPH_ID_COMMAND =
  "loop orchestration result-graph-id <config-path> <message-workflow-id>";

/**
 * The refusal of a reserved result graph id on `task-graphs/start`. The
 * refusal is the security property and stays; the body only tells the caller
 * which route replaces the call and how to compute the id it derives.
 */
const resultGraphIdReserved = (routePath: string | undefined): Response => {
  const route = routePath
    ? `Start the message's result graph with POST ${routePath}`
    : "This server has no A2A V2 route configured; on a host that has one, start the message's result graph with POST <routePath>/result-graph";
  return json(403, {
    error: {
      code: "result-graph-id-reserved",
      message: `${RESULT_GRAPH_ID_PREFIX}* workflow ids are reserved for message result graphs and are never started by task-graphs/start. ${route} and the JSON body {input, messageWorkflowId, requestId}; the host derives the graph id. Compute that id for a resultArtifacts entry with: ${RESULT_GRAPH_ID_COMMAND}`,
      replacement: {
        body: ["input", "messageWorkflowId", "requestId"],
        method: "POST",
        resultGraphIdCommand: RESULT_GRAPH_ID_COMMAND,
        route: routePath ?? null,
      },
    },
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): void => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("request fields are invalid");
  }
};

const requireString = (
  value: unknown,
  field: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
};

const parseIdentity = (
  value: SupervisorControlSurfaceIdentity | undefined
): SupervisorControlSurfaceIdentity | undefined => {
  if (!value) {
    return undefined;
  }
  return {
    principal: requireString(value.principal, "principal", PRINCIPAL_RE),
    supervisorId: requireString(
      value.supervisorId,
      "supervisorId",
      SUPERVISOR_ID_RE
    ),
  };
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new Error("content type is invalid");
  }
  // Only reached after authentication. A declared oversized body is refused
  // unread; an undeclared one is cancelled as soon as it crosses the cap.
  const text = await readBoundedRequestText(request, MAX_BODY_BYTES);
  if (text === undefined) {
    throw new RangeError("request body exceeds limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("request JSON is malformed");
  }
  if (!isRecord(value)) {
    throw new Error("request JSON must be an object");
  }
  return value;
};

const parseMessageExisting = (
  value: Record<string, unknown>,
  operation: "acknowledge" | "claim" | "tick"
) => {
  exactKeys(value, ["requestId", "workflowId"]);
  return {
    requestId: requireString(value.requestId, "requestId", STABLE_ID_RE),
    workflowId: requireString(value.workflowId, "workflowId", WORKFLOW_ID_RE),
    operation,
  };
};

const parseMessageReceive = (
  value: Record<string, unknown>,
  identity: SupervisorControlSurfaceIdentity,
  resolveRecipient?: (recipient: string) => string
): SupervisorMessageReceiveCommand => {
  // RA2: `inReplyTo` names the owner message a reply to the owner answers;
  // governance resolves it against the server's own ledger.
  const inReplyTo =
    value.inReplyTo === undefined
      ? undefined
      : requireString(value.inReplyTo, "inReplyTo", STABLE_ID_RE);
  exactKeys(value, [
    "input",
    "messageKind",
    "requestId",
    ...(inReplyTo === undefined ? [] : ["inReplyTo"]),
  ]);
  if (!isRecord(value.input) || value.input.from !== identity.supervisorId) {
    throw new Error("receive sender is invalid");
  }
  const to = value.input.to;
  const input =
    resolveRecipient && typeof to === "string" && SUPERVISOR_ID_RE.test(to)
      ? { ...value.input, to: resolveRecipient(to) }
      : value.input;
  return {
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    input: input as SupervisorMessageReceiveCommand["input"],
    messageKind: requireString(
      value.messageKind,
      "messageKind",
      MESSAGE_KIND_RE
    ) as SupervisorThreadMessageKind,
    principal: identity.principal,
    requestId: requireString(value.requestId, "requestId", STABLE_ID_RE),
  };
};

const parseGraphIdentity = (value: Record<string, unknown>) => {
  const requestId = requireString(value.requestId, "requestId", STABLE_ID_RE);
  const workflowId = requireString(
    value.workflowId,
    "workflowId",
    WORKFLOW_ID_RE
  );
  return { requestId, workflowId };
};

const workflowErrorResponse = (error: WorkflowError): Response => {
  switch (error.code) {
    case "invalid-command":
    case "unknown-query":
    case "unknown-signal":
    case "unknown-workflow-type":
      return errorResponse(400, "invalid-workflow-command");
    case "not-found":
      return errorResponse(404, "workflow-not-found");
    case "conflict":
    case "invalid-state":
      return errorResponse(409, "workflow-conflict");
    default:
      return errorResponse(500, "internal-error");
  }
};

const getRequest = async (
  options: SupervisorOrchestrationHttpOptions,
  pathname: string
): Promise<Response> => {
  if (pathname === `${API_PREFIX}/supervisor-threads`) {
    return json(200, { data: options.messages.threads() });
  }
  if (pathname === `${API_PREFIX}/supervisor-attention`) {
    return json(200, { data: options.messages.attention() });
  }
  if (pathname === `${API_PREFIX}/supervisor-knowledge`) {
    return json(200, { data: options.messages.knowledge() });
  }
  const match = GRAPH_QUERY_RE.exec(pathname);
  if (!match) {
    return errorResponse(404, "not-found");
  }
  const workflowId = requireString(match[1], "workflowId", WORKFLOW_ID_RE);
  return json(200, {
    data:
      match[2] === "ready"
        ? await options.tasks.ready(workflowId)
        : await options.tasks.status(workflowId),
  });
};

const postGraph = async (
  options: SupervisorOrchestrationHttpOptions,
  pathname: string,
  body: Record<string, unknown>,
  identity: SupervisorControlSurfaceIdentity
): Promise<Response | undefined> => {
  if (pathname === `${API_PREFIX}/task-graphs/start`) {
    exactKeys(body, ["input", "requestId", "workflowId"]);
    if (!isRecord(body.input)) {
      throw new Error("input is invalid");
    }
    // A message's result graph is started only by the A2A V2 result-graph
    // route, which derives its id under the host key. No caller here may
    // pre-start (squat) one under a chosen id.
    if (
      typeof body.workflowId === "string" &&
      body.workflowId.startsWith(RESULT_GRAPH_ID_PREFIX)
    ) {
      return resultGraphIdReserved(options.resultGraphRoutePath);
    }
    return json(200, {
      data: await options.tasks.start({
        input: body.input,
        ...parseGraphIdentity(body),
      }),
    });
  }
  if (pathname === `${API_PREFIX}/task-graphs/gates`) {
    exactKeys(body, [
      "artifactRef",
      "gateId",
      "requestId",
      "taskId",
      "workflowId",
    ]);
    return json(200, {
      data: await options.tasks.satisfyGate({
        payload: {
          artifactRef: requireString(
            body.artifactRef,
            "artifactRef",
            ARTIFACT_REF_RE
          ),
          gateId: requireString(body.gateId, "gateId", STABLE_ID_RE),
          taskId: requireString(body.taskId, "taskId", STABLE_ID_RE),
        },
        ...parseGraphIdentity(body),
      }),
    });
  }
  if (
    pathname === `${API_PREFIX}/task-graphs/claim` ||
    pathname === `${API_PREFIX}/task-graphs/begin`
  ) {
    exactKeys(body, ["requestId", "taskId", "workflowId"]);
    const command = {
      ...parseGraphIdentity(body),
      taskId: requireString(body.taskId, "taskId", STABLE_ID_RE),
      workerId: identity.principal,
    };
    return json(200, {
      data: pathname.endsWith("/claim")
        ? await options.tasks.claim(command)
        : await options.tasks.begin(command),
    });
  }
  if (pathname === `${API_PREFIX}/task-graphs/complete`) {
    exactKeys(body, ["receipts", "requestId", "taskId", "workflowId"]);
    if (!Array.isArray(body.receipts)) {
      throw new Error("receipts is invalid");
    }
    return json(200, {
      data: await options.tasks.complete({
        payload: {
          receipts: body.receipts,
          taskId: requireString(body.taskId, "taskId", STABLE_ID_RE),
          workerId: identity.principal,
        },
        ...parseGraphIdentity(body),
      }),
    });
  }
  if (pathname === `${API_PREFIX}/task-graphs/fail`) {
    exactKeys(body, ["failureCode", "requestId", "taskId", "workflowId"]);
    return json(200, {
      data: await options.tasks.fail({
        payload: {
          failureCode: requireString(
            body.failureCode,
            "failureCode",
            STABLE_ID_RE
          ),
          taskId: requireString(body.taskId, "taskId", STABLE_ID_RE),
          workerId: identity.principal,
        },
        ...parseGraphIdentity(body),
      }),
    });
  }
  if (pathname === `${API_PREFIX}/task-graphs/cancel`) {
    exactKeys(body, ["reason", "requestId", "workflowId"]);
    const ids = parseGraphIdentity(body);
    return json(200, {
      data: await options.tasks.cancel(
        ids.workflowId,
        ids.requestId,
        requireString(body.reason, "reason", STABLE_ID_RE)
      ),
    });
  }
  return undefined;
};

const postMessage = async (
  options: SupervisorOrchestrationHttpOptions,
  pathname: string,
  body: Record<string, unknown>,
  identity: SupervisorControlSurfaceIdentity
): Promise<Response | undefined> => {
  if (pathname === `${API_PREFIX}/supervisor-messages/receive`) {
    return json(200, {
      data: await options.messages.receive(
        parseMessageReceive(body, identity, options.resolveRecipient)
      ),
    });
  }
  if (
    pathname === `${API_PREFIX}/supervisor-messages/claim` ||
    pathname === `${API_PREFIX}/supervisor-messages/acknowledge` ||
    pathname === `${API_PREFIX}/supervisor-messages/tick`
  ) {
    const operation = pathname.split("/").at(-1) as
      | "acknowledge"
      | "claim"
      | "tick";
    const command = parseMessageExisting(body, operation);
    return json(200, {
      data: await options.messages[operation]({
        claimant: identity.supervisorId,
        principal: identity.principal,
        requestId: command.requestId,
        workflowId: command.workflowId,
      }),
    });
  }
  if (pathname === `${API_PREFIX}/supervisor-messages/cancel`) {
    exactKeys(body, ["reason", "requestId", "workflowId"]);
    return json(200, {
      data: await options.messages.cancel({
        claimant: identity.supervisorId,
        principal: identity.principal,
        reason: requireString(body.reason, "reason", STABLE_ID_RE),
        ...parseGraphIdentity(body),
      }),
    });
  }
  return undefined;
};

const handleAuthenticatedRequest = async (
  options: SupervisorOrchestrationHttpOptions,
  request: Request,
  identity: SupervisorControlSurfaceIdentity
): Promise<Response> => {
  const { pathname } = new URL(request.url);
  try {
    if (request.method === "GET") {
      return await getRequest(options, pathname);
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method-not-allowed");
    }
    const body = await readJson(request);
    return (
      (await postGraph(options, pathname, body, identity)) ??
      (await postMessage(options, pathname, body, identity)) ??
      errorResponse(404, "not-found")
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse(413, "body-too-large");
    }
    if (error instanceof SupervisorMessageGovernanceError) {
      // RA2: an unprompted message to the owner is told the right path.
      return error.reasonCode === OWNER_REPLY_ONLY
        ? ownerReplyOnlyResponse()
        : errorResponse(403, "authority-denied");
    }
    if (error instanceof WorkflowError) {
      return workflowErrorResponse(error);
    }
    if (error instanceof Error && error.message.includes("invalid")) {
      return errorResponse(400, "invalid-request");
    }
    return errorResponse(500, "internal-error");
  }
};

export const createSupervisorOrchestrationHttpHandler =
  (
    options: SupervisorOrchestrationHttpOptions
  ): ((request: Request) => Promise<Response>) =>
  async (request): Promise<Response> => {
    let identity: SupervisorControlSurfaceIdentity | undefined;
    try {
      identity = parseIdentity(
        await options.authenticator.authenticate(request)
      );
    } catch {
      return errorResponse(401, "unauthorized");
    }
    if (!identity) {
      return errorResponse(401, "unauthorized");
    }
    return handleAuthenticatedRequest(options, request, identity);
  };

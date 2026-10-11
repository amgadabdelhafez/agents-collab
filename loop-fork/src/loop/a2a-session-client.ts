import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Message, Role, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { agentCardFor, FROM_METADATA_KEY } from "./a2a-supervisor-adapter";
import {
  TASK_STATE_METADATA_KEY,
  WORKFLOW_ID_METADATA_KEY,
} from "./a2a-supervisor-executor";
import {
  A2A_V2_MESSAGE_STATUS_SCHEMA,
  A2A_V2_ROUTE_ERROR_STATUS,
  A2A_V2_SESSION_RECEIPT_SCHEMA,
  A2A_V2_SESSION_REQUEST_SCHEMAS,
  type A2AV2MessageStatusResponse,
  type A2AV2RouteErrorCode,
  type A2AV2SessionOperation,
  type A2AV2SessionReceipt,
  type A2AV2TaskStateName,
  a2aV2MessageStatusPath,
  a2aV2SessionRoutePath,
  a2aV2SupervisorIngressPath,
  a2aV2TaskStateName,
  a2aV2WorkResultCompleted,
  parseA2AV2SessionRequest,
} from "./a2a-v2-routes-contract";
import {
  ORCHESTRATION_CONFIG_PATH_ENV,
  orchestrationConfigPathFromEnv,
} from "./governess-temporal-journal";
import {
  isLoopbackLiteral,
  parseServerOrigin,
  serverOriginFor,
} from "./orchestration-origin-policy";
import {
  OWNER_NOTIFICATION_PATH,
  OWNER_REPLY_ONLY,
  OWNER_REPLY_ONLY_MESSAGE,
} from "./orchestration-owner-messaging";
import {
  acknowledgeRecipientWorkflow,
  isSupervisorMessageV2WorkflowId,
  RecipientAcknowledgementError,
} from "./recipient-api-client";
import { readRunManifest, updateRunManifest } from "./run-state";
import {
  isSupervisorEndpointKind,
  parseSupervisorEndpointLocator,
  requireSupervisorEndpointHolderRef,
  requireSupervisorEndpointRecipient,
  type SupervisorEndpointKind,
  type SupervisorEndpointLocator,
  supervisorEndpointRoots,
  supervisorEndpointSessionDir,
} from "./supervisor-endpoint-lease";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";

/**
 * T4 client side of the r9 routes (`a2a-v2-routes-contract.ts`): session
 * claim/renew/release, the per-supervisor SDK ingress, the sender's message
 * status, and the recipient ACK. Shared by `loop a2a`, the bridge's session
 * mode tools, the `--a2a-as` launch and the teardown hooks.
 *
 * - The server is the orchestration config's own: its configured `origin`
 *   (https, or http on 127.0.0.1 or [::1]; RA1's origin policy), else its
 *   loopback listener (`hostname` 127.0.0.1 or ::1, `port`), with
 *   `a2aV2.routePath`; nothing here takes a server URL from argv or tool
 *   input.
 * - The bearer token is the acting supervisor's `tokenEnv`, read from the
 *   environment and held in a private field: no result, error or log line
 *   carries it. Only that one variable is read, and an environment that also
 *   holds another configured supervisor's token is refused unless the caller
 *   opts in (`--allow-multi-token-env`): a process that can read several
 *   tokens could act as any of them.
 * - A `LOOP_ORCHESTRATION_CONFIG` override must be a regular file owned by
 *   the current user and not group- or world-writable: whoever can write it
 *   chooses where the token goes.
 * - Every request URL is checked against the config's own origin before the
 *   token is attached; nothing derived from message content or tool input
 *   can move it elsewhere.
 * - The acting identity is fixed by the caller (`--as`, or the bridge
 *   session's own directory, fixed when the bridge starts) before any other
 *   input is read; a message's `from` is always that identity.
 * - Locators are ids only; the server derives every path and URL itself.
 * - Delivery, the read ACK and completion stay three separate facts: a send
 *   reports acceptance, `ack` reports the acknowledgement, and only a
 *   published result (`workResultCompleted`) is completion.
 */

export const A2A_LEASE_RECORD_FILE = "a2a-lease.json";
export const A2A_LEASE_RECORD_SCHEMA = "loop-a2a-lease-record.v1" as const;
const REQUEST_TIMEOUT_MS = 10_000;
const ROUTE_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/;
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const TASK_STATE_NAME_RE = /^TASK_STATE_[A-Z_]+$/;
const MESSAGE_PHASES: readonly string[] = [
  "acknowledged",
  "canceled",
  "claimed",
  "dead-lettered",
  "escalated",
  "retry-scheduled",
  "routed",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafePositive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1;

const isNullableString = (value: unknown): value is null | string =>
  value === null || typeof value === "string";

/** A fixed, token-free failure. `code` is a route error code or a client one. */
export class A2AClientError extends Error {
  readonly code: A2AV2RouteErrorCode | "invalid-response" | "unavailable";
  readonly detail?: Record<string, unknown>;
  constructor(
    message: string,
    code: A2AClientError["code"],
    detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = "A2AClientError";
    this.code = code;
    if (detail) {
      this.detail = detail;
    }
  }
}

/**
 * The acting supervisor's connection to its own orchestration server. The
 * token is a private field, so `JSON.stringify`, `inspect` and string
 * conversion never render it.
 */
export class A2AClientEndpoint {
  readonly baseUrl: string;
  readonly routePath: string;
  readonly supervisorId: string;
  readonly #token: string;
  constructor(input: {
    baseUrl: string;
    routePath: string;
    supervisorId: string;
    token: string;
  }) {
    this.baseUrl = input.baseUrl;
    this.routePath = input.routePath;
    this.supervisorId = input.supervisorId;
    this.#token = input.token;
  }
  authorization(): string {
    return `Bearer ${this.#token}`;
  }
  /** For the recipient route client, which takes the raw token. */
  token(): string {
    return this.#token;
  }
  /**
   * `path` on this endpoint's own origin. A path that could leave it (no
   * leading slash, a `//` authority, a backslash, whitespace or a control
   * character) is refused, so the token only ever goes to the configured
   * server.
   */
  url(path: string): string {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      UNSAFE_PATH_RE.test(path)
    ) {
      throw new Error("A2A request path is not on the configured server");
    }
    const url = `${this.baseUrl}${path}`;
    if (new URL(url).origin !== new URL(this.baseUrl).origin) {
      throw new Error("A2A request path is not on the configured server");
    }
    return url;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
const UNSAFE_PATH_RE = /[\\\s\u0000-\u001f\u007f]/;

export interface A2AClientDeps {
  /**
   * Accept an environment that also exposes other configured supervisors'
   * token variables (the CLI's `--allow-multi-token-env`). Off by default;
   * the bridge's MCP tools never set it.
   */
  allowMultiTokenEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The current user's uid, for the config override check (tests). */
  uid?: () => number;
}

/**
 * Read the orchestration config through one descriptor. An override from
 * `LOOP_ORCHESTRATION_CONFIG` must be a regular file owned by the current
 * user with no group or world write bit; the checks run on the descriptor
 * that is read, so the file cannot be swapped in between.
 */
const readOrchestrationConfigText = (
  configPath: string,
  env: NodeJS.ProcessEnv,
  deps: A2AClientDeps
): string => {
  const override = Boolean(env[ORCHESTRATION_CONFIG_PATH_ENV]?.trim());
  let fd: number;
  try {
    // Non-blocking, so a FIFO planted at the path cannot hang the open.
    // biome-ignore lint/suspicious/noBitwiseOperators: open flags
    fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    throw new Error(`orchestration config is unavailable: ${configPath}`);
  }
  try {
    if (override) {
      const stat = fstatSync(fd);
      const uid = (deps.uid ?? (() => process.getuid?.() ?? -1))();
      if (!stat.isFile()) {
        throw new Error(
          `${ORCHESTRATION_CONFIG_PATH_ENV} is not a regular file: ${configPath}`
        );
      }
      if (stat.uid !== uid) {
        throw new Error(
          `${ORCHESTRATION_CONFIG_PATH_ENV} is not owned by the current user: ${configPath}`
        );
      }
      // biome-ignore lint/suspicious/noBitwiseOperators: mode bits
      if ((stat.mode & 0o022) !== 0) {
        throw new Error(
          `${ORCHESTRATION_CONFIG_PATH_ENV} is group- or world-writable: ${configPath}`
        );
      }
    }
    try {
      return readFileSync(fd, "utf8");
    } catch {
      throw new Error(`orchestration config is unavailable: ${configPath}`);
    }
  } finally {
    closeSync(fd);
  }
};

/**
 * The names (never the values) of the other configured supervisors' token
 * variables that are set in `env`.
 */
export const otherSupervisorTokenEnvs = (
  config: Record<string, unknown>,
  ownTokenEnv: string,
  env: NodeJS.ProcessEnv
): string[] => {
  const names = new Set<string>();
  const entries = Array.isArray(config.supervisors) ? config.supervisors : [];
  for (const entry of entries) {
    const name = isRecord(entry) ? entry.tokenEnv : undefined;
    if (
      typeof name === "string" &&
      TOKEN_ENV_RE.test(name) &&
      name !== ownTokenEnv &&
      env[name]
    ) {
      names.add(name);
    }
  }
  return [...names].sort();
};

/**
 * RA1: the server origin a client sends its token to. A configured `origin`
 * passes the shared origin policy (https, or http on a loopback IP
 * literal); without one, the loopback listener (127.0.0.1 or ::1 only:
 * `localhost` could resolve anywhere).
 */
const clientServerOrigin = (config: Record<string, unknown>): string => {
  if (config.origin !== undefined) {
    return parseServerOrigin(config.origin, "orchestration origin");
  }
  const hostname = config.hostname;
  if (!(typeof hostname === "string" && isLoopbackLiteral(hostname))) {
    throw new Error(
      "orchestration hostname must be 127.0.0.1 or ::1 for the A2A client, or the config must name an origin"
    );
  }
  const port = config.port;
  if (
    !(Number.isSafeInteger(port) && Number(port) >= 1 && Number(port) <= 65_535)
  ) {
    throw new Error("orchestration port is invalid");
  }
  return serverOriginFor({ hostname, port: Number(port) });
};

/**
 * Resolve `supervisorId`'s server and token from the orchestration config
 * (`LOOP_ORCHESTRATION_CONFIG`, default `~/.loop/orchestration/config.json`).
 * Reads only the keys it needs, so it does not depend on which A2A V2 parser
 * the server runs.
 */
export const resolveA2AClientEndpoint = (
  supervisorIdValue: string,
  deps: A2AClientDeps = {}
): A2AClientEndpoint => {
  const env = deps.env ?? process.env;
  const supervisorId = requireSupervisorEndpointRecipient(supervisorIdValue);
  const configPath = orchestrationConfigPathFromEnv(env);
  const text = readOrchestrationConfigText(configPath, env, deps);
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`orchestration config is unavailable: ${configPath}`);
  }
  if (!isRecord(config)) {
    throw new Error(`orchestration config is invalid: ${configPath}`);
  }
  const baseUrl = clientServerOrigin(config);
  const a2aV2 = config.a2aV2;
  if (!isRecord(a2aV2)) {
    throw new Error("A2A V2 is not configured in the orchestration config");
  }
  const routePath = a2aV2.routePath;
  if (!(typeof routePath === "string" && ROUTE_PATH_RE.test(routePath))) {
    throw new Error("orchestration a2aV2 routePath is invalid");
  }
  const supervisor = Array.isArray(config.supervisors)
    ? config.supervisors.find(
        (entry) => isRecord(entry) && entry.supervisorId === supervisorId
      )
    : undefined;
  if (!isRecord(supervisor)) {
    throw new Error(`${supervisorId} is not a configured supervisor`);
  }
  const tokenEnv = supervisor.tokenEnv;
  if (!(typeof tokenEnv === "string" && TOKEN_ENV_RE.test(tokenEnv))) {
    throw new Error(`${supervisorId} has an invalid tokenEnv`);
  }
  const token = env[tokenEnv];
  if (!token) {
    throw new Error(
      `${supervisorId}'s token environment ${tokenEnv} is not set`
    );
  }
  // One identity per process: an environment that could also act as another
  // supervisor is refused unless the caller opted in. Names only, never values.
  const others = otherSupervisorTokenEnvs(config, tokenEnv, env);
  if (others.length > 0 && deps.allowMultiTokenEnv !== true) {
    throw new Error(
      `the environment also holds other supervisors' token variables (${others.join(", ")}); run each session with only ${tokenEnv} set, or pass --allow-multi-token-env`
    );
  }
  return new A2AClientEndpoint({
    baseUrl,
    routePath,
    supervisorId,
    token,
  });
};

const routeErrorCode = (value: unknown): A2AV2RouteErrorCode | undefined => {
  const code =
    isRecord(value) && isRecord(value.error) ? value.error.code : undefined;
  return typeof code === "string" && code in A2A_V2_ROUTE_ERROR_STATUS
    ? (code as A2AV2RouteErrorCode)
    : undefined;
};

/** One JSON request to the server. Never follows a redirect. */
const requestJson = async (
  endpoint: A2AClientEndpoint,
  input: { body?: unknown; method: "GET" | "POST"; path: string },
  what: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetchImpl(endpoint.url(input.path), {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: {
        authorization: endpoint.authorization(),
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      method: input.method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new A2AClientError(
      `${what}: the server is unavailable`,
      "unavailable"
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const code = routeErrorCode(value);
    if (!code) {
      throw new A2AClientError(
        `${what}: the server refused (${response.status})`,
        "unavailable"
      );
    }
    throw new A2AClientError(
      `${what} refused: ${code}`,
      code,
      routeErrorDetail(code, value)
    );
  }
  return value;
};

/** Only the two refusals the contract details: the holder, or the fence reason. */
const routeErrorDetail = (
  code: A2AV2RouteErrorCode,
  value: unknown
): Record<string, unknown> | undefined => {
  const error = isRecord(value) && isRecord(value.error) ? value.error : {};
  if (code === "lease-held" && isRecord(error.current)) {
    return { current: error.current };
  }
  if (code === "lease-fenced" && typeof error.reason === "string") {
    return { reason: error.reason };
  }
  return undefined;
};

const requireReceipt = (
  value: unknown,
  operation: A2AV2SessionOperation,
  supervisorId: string,
  holderRef: string
): A2AV2SessionReceipt => {
  if (
    !(
      isRecord(value) &&
      value.schema === A2A_V2_SESSION_RECEIPT_SCHEMA &&
      value.operation === operation &&
      value.supervisorId === supervisorId &&
      value.holderRef === holderRef &&
      isSafePositive(value.epoch) &&
      Number.isSafeInteger(value.descriptorRevision) &&
      typeof value.expiresAt === "string" &&
      isNullableString(value.releasedAt) &&
      isSupervisorEndpointKind(value.kind) &&
      (value.changed === undefined || typeof value.changed === "boolean") &&
      (value.tookOver === undefined || typeof value.tookOver === "boolean")
    )
  ) {
    throw new A2AClientError(
      `${operation}: the server returned an invalid receipt`,
      "invalid-response"
    );
  }
  return {
    ...(value.changed === undefined ? {} : { changed: value.changed }),
    descriptorRevision: value.descriptorRevision as number,
    epoch: value.epoch,
    expiresAt: value.expiresAt,
    holderRef,
    kind: value.kind,
    operation,
    releasedAt: value.releasedAt,
    schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
    supervisorId,
    ...(value.tookOver === undefined ? {} : { tookOver: value.tookOver }),
  };
};

export interface A2AClaimInput {
  holderRef: string;
  locator: SupervisorEndpointLocator;
  sessionRef: string;
  takeover?: boolean;
  ttlMs?: number;
}

export const claimA2ASession = async (
  endpoint: A2AClientEndpoint,
  input: A2AClaimInput,
  fetchImpl?: typeof fetch
): Promise<A2AV2SessionReceipt> => {
  // The same strict decode the server applies, so a malformed claim never
  // leaves this process.
  const body = parseA2AV2SessionRequest("claim", {
    holderRef: input.holderRef,
    locator: input.locator,
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.claim,
    sessionRef: input.sessionRef,
    supervisorId: endpoint.supervisorId,
    ...(input.takeover ? { takeover: true } : {}),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  return requireReceipt(
    await requestJson(
      endpoint,
      {
        body,
        method: "POST",
        path: a2aV2SessionRoutePath(endpoint.routePath, "claim"),
      },
      "claim",
      fetchImpl
    ),
    "claim",
    endpoint.supervisorId,
    body.holderRef
  );
};

export const renewA2ASession = async (
  endpoint: A2AClientEndpoint,
  fence: { epoch: number; holderRef: string; ttlMs?: number },
  fetchImpl?: typeof fetch
): Promise<A2AV2SessionReceipt> => {
  const body = parseA2AV2SessionRequest("renew", {
    epoch: fence.epoch,
    holderRef: fence.holderRef,
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.renew,
    supervisorId: endpoint.supervisorId,
    ...(fence.ttlMs === undefined ? {} : { ttlMs: fence.ttlMs }),
  });
  return requireReceipt(
    await requestJson(
      endpoint,
      {
        body,
        method: "POST",
        path: a2aV2SessionRoutePath(endpoint.routePath, "renew"),
      },
      "renew",
      fetchImpl
    ),
    "renew",
    endpoint.supervisorId,
    body.holderRef
  );
};

export const releaseA2ASession = async (
  endpoint: A2AClientEndpoint,
  fence: { epoch: number; holderRef: string },
  fetchImpl?: typeof fetch
): Promise<A2AV2SessionReceipt> => {
  const body = parseA2AV2SessionRequest("release", {
    epoch: fence.epoch,
    holderRef: fence.holderRef,
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.release,
    supervisorId: endpoint.supervisorId,
  });
  return requireReceipt(
    await requestJson(
      endpoint,
      {
        body,
        method: "POST",
        path: a2aV2SessionRoutePath(endpoint.routePath, "release"),
      },
      "release",
      fetchImpl
    ),
    "release",
    endpoint.supervisorId,
    body.holderRef
  );
};

/** The sender's own view of one message. Three facts, never merged. */
export const a2aMessageStatus = async (
  endpoint: A2AClientEndpoint,
  messageId: string,
  fetchImpl?: typeof fetch
): Promise<A2AV2MessageStatusResponse> => {
  const path = a2aV2MessageStatusPath(endpoint.routePath, messageId);
  const value = await requestJson(
    endpoint,
    { method: "GET", path },
    "status",
    fetchImpl
  );
  const taskState = isRecord(value) ? value.taskState : undefined;
  if (
    !(
      isRecord(value) &&
      value.schema === A2A_V2_MESSAGE_STATUS_SCHEMA &&
      value.messageId === messageId &&
      typeof value.phase === "string" &&
      MESSAGE_PHASES.includes(value.phase) &&
      isNullableString(value.deliveredAt) &&
      isNullableString(value.acknowledgedAt) &&
      (taskState === null ||
        (typeof taskState === "string" &&
          TASK_STATE_NAME_RE.test(taskState))) &&
      typeof value.to === "string" &&
      // Completion is only ever a published result: a server that reports it
      // for any other task state is not believed.
      value.workResultCompleted ===
        a2aV2WorkResultCompleted(taskState as A2AV2TaskStateName | null)
    )
  ) {
    throw new A2AClientError(
      "status: the server returned an invalid status",
      "invalid-response"
    );
  }
  return {
    acknowledgedAt: value.acknowledgedAt as null | string,
    deliveredAt: value.deliveredAt as null | string,
    messageId,
    phase: value.phase as SupervisorMessagePhase,
    schema: A2A_V2_MESSAGE_STATUS_SCHEMA,
    taskState: taskState as A2AV2TaskStateName | null,
    to: value.to,
    workResultCompleted: value.workResultCompleted as boolean,
  };
};

const MESSAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const CONTEXT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const MAX_BODY_BYTES = 64 * 1024;

export interface A2ASendInput {
  body: string;
  contextId?: string;
  messageId: string;
  to: string;
}

export interface A2ASendReceipt {
  /** Acceptance by the recipient's server. Not delivery, ACK or completion. */
  accepted: true;
  messageId: string;
  taskId: string;
  taskState: A2AV2TaskStateName | null;
  to: string;
  workflowId: null | string;
  workResultCompleted: boolean;
}

/**
 * The fetch the SDK client gets: the one ingress URL only, the bearer token
 * added here (never in the card or the request body), redirects refused.
 */
export const a2aIngressFetch = (
  endpoint: A2AClientEndpoint,
  url: string,
  fetchImpl: typeof fetch = fetch
): typeof fetch =>
  Object.assign(
    (
      resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      // One Request from either call form, so a Request resource keeps its
      // method and body.
      const request = new Request(resource, init);
      if (request.url !== url) {
        return Promise.reject(new Error("unexpected A2A request target"));
      }
      const headers = new Headers(request.headers);
      headers.set("authorization", endpoint.authorization());
      return fetchImpl(
        new Request(request, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      );
    },
    { preconnect: fetch.preconnect }
  );

/**
 * Send one message to `{routePath}/supervisors/<slug>` through the SDK's own
 * JSON-RPC client, built from a local agent card (no card is fetched). The
 * fetch it uses adds the bearer token, refuses redirects and refuses any URL
 * but the one ingress.
 */
export const sendA2AMessage = async (
  endpoint: A2AClientEndpoint,
  input: A2ASendInput,
  fetchImpl: typeof fetch = fetch
): Promise<A2ASendReceipt> => {
  const to = requireSupervisorEndpointRecipient(input.to);
  if (!MESSAGE_ID_RE.test(input.messageId)) {
    throw new Error("message id is invalid");
  }
  if (input.contextId !== undefined && !CONTEXT_ID_RE.test(input.contextId)) {
    throw new Error("context id is invalid");
  }
  if (
    !input.body.trim() ||
    new TextEncoder().encode(input.body).byteLength > MAX_BODY_BYTES
  ) {
    throw new Error("message body must be non-empty and at most 64 KiB");
  }
  const url = endpoint.url(a2aV2SupervisorIngressPath(endpoint.routePath, to));
  // RA2: the SDK reports any refusal as a transport error; the ingress's
  // owner-reply-only refusal is kept so the caller is told the right path.
  let ownerReplyOnly = false;
  const observed = Object.assign(
    async (
      resource: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const response = await fetchImpl(resource, init);
      if (response.status === 403) {
        const value: unknown = await response
          .clone()
          .json()
          .catch(() => undefined);
        ownerReplyOnly = routeErrorCode(value) === OWNER_REPLY_ONLY;
      }
      return response;
    },
    { preconnect: fetch.preconnect }
  );
  const authenticated = a2aIngressFetch(endpoint, url, observed);
  const message: Message = {
    contextId: input.contextId ?? input.messageId,
    extensions: [],
    messageId: input.messageId,
    metadata: { [FROM_METADATA_KEY]: endpoint.supervisorId },
    parts: [
      {
        content: { $case: "text", value: input.body },
        filename: "",
        mediaType: "",
        metadata: undefined,
      },
    ],
    referenceTaskIds: [],
    role: Role.ROLE_USER,
    taskId: "",
  };
  let result: Message | Task;
  try {
    const client = await new ClientFactory({
      clientConfig: { polling: true },
      transports: [new JsonRpcTransportFactory({ fetchImpl: authenticated })],
    }).createFromAgentCard(
      agentCardFor({
        description: `A2A V2 ingress of ${to}.`,
        supervisorId: to,
        url,
      })
    );
    result = await client.sendMessage({
      configuration: undefined,
      message,
      metadata: undefined,
      tenant: "",
    });
  } catch {
    if (ownerReplyOnly) {
      throw new A2AClientError(
        `send refused: ${OWNER_REPLY_ONLY_MESSAGE} Nothing is claimed delivered.`,
        OWNER_REPLY_ONLY,
        { notifyVia: OWNER_NOTIFICATION_PATH }
      );
    }
    throw new A2AClientError(
      "send refused or the server is unavailable; nothing is claimed delivered",
      "unavailable"
    );
  }
  if (!("status" in result && typeof result.id === "string" && result.id)) {
    throw new A2AClientError(
      "send: the server did not return a task",
      "invalid-response"
    );
  }
  const taskState = a2aV2TaskStateName(result.status?.state);
  // The server's executor answers a refused turn (an invalid message or
  // policy, a refused start) with a task that has already ended: that is a
  // refusal, never acceptance.
  if (
    taskState === "TASK_STATE_FAILED" ||
    taskState === "TASK_STATE_REJECTED"
  ) {
    const reason = result.metadata?.[TASK_STATE_METADATA_KEY];
    throw new A2AClientError(
      `send refused by the recipient's server (${taskState}); nothing is claimed delivered`,
      "unavailable",
      typeof reason === "string" ? { reason: reason.slice(0, 200) } : undefined
    );
  }
  const workflowId = result.metadata?.[WORKFLOW_ID_METADATA_KEY];
  return {
    accepted: true,
    messageId: input.messageId,
    taskId: result.id,
    taskState,
    to,
    workflowId: typeof workflowId === "string" ? workflowId : null,
    workResultCompleted: a2aV2WorkResultCompleted(taskState),
  };
};

/** The recipient's delivery/read ACK of V2 workflows; never completion. */
/** A refusal's reason: refusal codes only, never free text from a response. */
const ackRefusalReason = (error: unknown): string => {
  if (error instanceof RecipientAcknowledgementError) {
    return error.reason;
  }
  return "refused";
};

export const acknowledgeA2AWorkflows = async (
  endpoint: A2AClientEndpoint,
  workflowIds: readonly string[],
  fetchImpl?: typeof fetch,
  /** How early refusals are waited out (acknowledgeRecipientWorkflow). */
  early: {
    earlyWaitMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{
  acknowledged: { phase: string; workflowId: string }[];
  refused: { reason: string; workflowId: string }[];
  workResultCompleted: false;
}> => {
  const acknowledged: { phase: string; workflowId: string }[] = [];
  const refused: { reason: string; workflowId: string }[] = [];
  for (const workflowId of workflowIds) {
    if (!isSupervisorMessageV2WorkflowId(workflowId)) {
      refused.push({ reason: "not-a-v2-workflow-id", workflowId });
      continue;
    }
    try {
      const receipt = await acknowledgeRecipientWorkflow({
        ...early,
        fetchImpl,
        token: endpoint.token(),
        url: endpoint.url(`${endpoint.routePath}/recipient`),
        workflowId,
      });
      acknowledged.push({ phase: receipt.phase, workflowId });
    } catch (error) {
      refused.push({ reason: ackRefusalReason(error), workflowId });
    }
  }
  return { acknowledged, refused, workResultCompleted: false };
};

/* ---------------------------------------------------------------------------
 * The local lease record: the fence a later release must present, kept next
 * to the endpoint it names (a run dir or a session dir). Never a token.
 * ------------------------------------------------------------------------- */

export interface A2ALeaseRecord {
  claimedAt: string;
  epoch: number;
  expiresAt: string;
  holderRef: string;
  kind: SupervisorEndpointKind;
  locator: SupervisorEndpointLocator;
  releasedAt: null | string;
  schema: typeof A2A_LEASE_RECORD_SCHEMA;
  supervisorId: string;
}

export const a2aLeaseRecordPath = (dir: string): string =>
  join(dir, A2A_LEASE_RECORD_FILE);

export const readA2ALeaseRecord = (dir: string): A2ALeaseRecord | undefined => {
  const path = a2aLeaseRecordPath(dir);
  if (!existsSync(path)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is unreadable`);
  }
  try {
    if (!(isRecord(value) && value.schema === A2A_LEASE_RECORD_SCHEMA)) {
      throw new Error("schema");
    }
    const locator = parseSupervisorEndpointLocator(value.locator);
    if (
      !(
        isSafePositive(value.epoch) &&
        typeof value.claimedAt === "string" &&
        typeof value.expiresAt === "string" &&
        isNullableString(value.releasedAt) &&
        value.kind === locator.kind
      )
    ) {
      throw new Error("fields");
    }
    return {
      claimedAt: value.claimedAt,
      epoch: value.epoch,
      expiresAt: value.expiresAt,
      holderRef: requireSupervisorEndpointHolderRef(value.holderRef),
      kind: locator.kind,
      locator,
      releasedAt: value.releasedAt,
      schema: A2A_LEASE_RECORD_SCHEMA,
      supervisorId: requireSupervisorEndpointRecipient(value.supervisorId),
    };
  } catch {
    throw new Error(`${path} is not a valid A2A lease record`);
  }
};

const writeA2ALeaseRecord = (dir: string, record: A2ALeaseRecord): void => {
  const path = a2aLeaseRecordPath(dir);
  const temp = join(
    dir,
    `.${A2A_LEASE_RECORD_FILE}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

export interface A2AClaimOptions extends A2AClientDeps {
  now?: () => string;
  takeover?: boolean;
  ttlMs?: number;
}

export interface A2AClaimResult {
  dir: string;
  receipt: A2AV2SessionReceipt;
  record: A2ALeaseRecord;
}

const claimAndRecord = async (
  dir: string,
  supervisorId: string,
  claim: Omit<A2AClaimInput, "takeover" | "ttlMs">,
  options: A2AClaimOptions
): Promise<A2AClaimResult> => {
  const endpoint = resolveA2AClientEndpoint(supervisorId, options);
  const receipt = await claimA2ASession(
    endpoint,
    {
      ...claim,
      ...(options.takeover ? { takeover: true } : {}),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    },
    options.fetchImpl
  );
  const record: A2ALeaseRecord = {
    claimedAt: (options.now ?? (() => new Date().toISOString()))(),
    epoch: receipt.epoch,
    expiresAt: receipt.expiresAt,
    holderRef: receipt.holderRef,
    kind: claim.locator.kind,
    locator: claim.locator,
    releasedAt: null,
    schema: A2A_LEASE_RECORD_SCHEMA,
    supervisorId: endpoint.supervisorId,
  };
  writeA2ALeaseRecord(dir, record);
  return { dir, receipt, record };
};

/**
 * Claim a Loop run as `supervisorId`'s endpoint, by ids only: write
 * `a2aSupervisorId` into the run manifest (the server requires the manifest
 * to name the claimant), then claim {repoId, runId, seat} (loop-run) or
 * {repoId, runId, threadId} (codex-thread) with the session id the manifest
 * records. The fence is kept in `<runDir>/a2a-lease.json` for the release.
 */
export const claimRunA2AEndpoint = async (
  input: {
    kind?: "codex-thread" | "loop-run";
    manifestPath: string;
    runDir: string;
    seat?: "claude" | "codex";
    supervisorId: string;
  },
  options: A2AClaimOptions = {}
): Promise<A2AClaimResult> => {
  const supervisorId = requireSupervisorEndpointRecipient(input.supervisorId);
  const kind = input.kind ?? "loop-run";
  // A run the manifest already names as another supervisor's endpoint is
  // that supervisor's: renaming it is a takeover, which only the explicit
  // human `--takeover` flag asks for.
  const named = updateRunManifest(input.manifestPath, (current) => {
    if (!current) {
      return undefined;
    }
    const recorded = current.a2aSupervisorId;
    if (recorded && recorded !== supervisorId && options.takeover !== true) {
      throw new Error(
        `the run is enrolled as ${recorded}; only an explicit --takeover renames it`
      );
    }
    return { ...current, a2aSupervisorId: supervisorId };
  });
  // The server re-reads the manifest it derives and refuses one that does not
  // name this supervisor, so this only needs the run to exist.
  const manifest = named && readRunManifest(input.manifestPath);
  if (!manifest) {
    throw new Error("the run manifest is unavailable");
  }
  if (kind === "codex-thread") {
    if (!manifest.codexThreadId) {
      throw new Error("the run has no Codex thread id yet");
    }
    return await claimAndRecord(
      input.runDir,
      supervisorId,
      {
        holderRef: `codex-thread:${manifest.repoId}:${manifest.runId}`,
        locator: {
          kind: "codex-thread",
          repoId: manifest.repoId,
          runId: manifest.runId,
          threadId: manifest.codexThreadId,
        },
        sessionRef: `session:${manifest.codexThreadId}`,
      },
      options
    );
  }
  const primary = manifest.primaryAgent;
  const seat =
    input.seat ??
    (primary === "claude" || primary === "codex" ? primary : undefined);
  if (!seat) {
    throw new Error("the run's seat is not claude or codex; pass --seat");
  }
  const session =
    seat === "claude" ? manifest.claudeSessionId : manifest.codexThreadId;
  if (!session) {
    throw new Error(`the run has no ${seat} session id yet`);
  }
  return await claimAndRecord(
    input.runDir,
    supervisorId,
    {
      holderRef: `loop-run:${manifest.repoId}:${manifest.runId}:${seat}`,
      locator: {
        kind: "loop-run",
        repoId: manifest.repoId,
        runId: manifest.runId,
        seat,
      },
      sessionRef: `session:${session}`,
    },
    options
  );
};

/** `<home>/.loop/sessions/<slug>/<sessionId>`: the same derivation as the server. */
export const a2aChannelSessionDir = (
  supervisorId: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string =>
  supervisorEndpointSessionDir(
    supervisorEndpointRoots(env.HOME?.trim() || homedir()),
    supervisorId,
    sessionId
  );

/**
 * Claim a standalone Claude Code session (served by `__bridge-mcp
 * <sessionDir> claude`) as `supervisorId`'s endpoint. The session dir is
 * created under the caller's own sessions root; the server derives the same
 * path from its own root and the ids.
 */
export const claimChannelA2AEndpoint = async (
  input: {
    /** The Claude session id, when known; defaults to the session id. */
    providerSessionId?: string;
    sessionId: string;
    supervisorId: string;
  },
  options: A2AClaimOptions = {}
): Promise<A2AClaimResult> => {
  const supervisorId = requireSupervisorEndpointRecipient(input.supervisorId);
  // The contract's derivation refuses any session id that is not one safe
  // path segment, before anything is created or sent.
  const dir = a2aChannelSessionDir(supervisorId, input.sessionId, options.env);
  const sessionId = input.sessionId;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return await claimAndRecord(
    dir,
    supervisorId,
    {
      holderRef: `claude-channel:${sessionId}`,
      locator: { kind: "claude-channel", sessionId },
      sessionRef: `session:${input.providerSessionId ?? sessionId}`,
    },
    options
  );
};

export type A2ALeaseReleaseOutcome =
  | { outcome: "none" }
  | { outcome: "already-released"; releasedAt: string; supervisorId: string }
  | { changed: boolean; outcome: "released"; supervisorId: string }
  | { outcome: "fenced"; reason: string; supervisorId: string }
  | { detail: string; outcome: "failed"; supervisorId?: string };

/**
 * Release the lease recorded in `dir`, presenting its fence. NEVER throws:
 * teardown calls it and must not have an error masked or a run failed by it.
 * A fenced release (another holder claimed since) is reported, not retried.
 */
export const releaseRecordedA2ALease = async (
  dir: string,
  options: A2AClientDeps & { now?: () => string } = {}
): Promise<A2ALeaseReleaseOutcome> => {
  let record: A2ALeaseRecord | undefined;
  try {
    record = readA2ALeaseRecord(dir);
  } catch (error) {
    return {
      detail:
        error instanceof Error ? error.message : "unreadable lease record",
      outcome: "failed",
    };
  }
  if (!record) {
    return { outcome: "none" };
  }
  if (record.releasedAt) {
    return {
      outcome: "already-released",
      releasedAt: record.releasedAt,
      supervisorId: record.supervisorId,
    };
  }
  try {
    const endpoint = resolveA2AClientEndpoint(record.supervisorId, options);
    const receipt = await releaseA2ASession(
      endpoint,
      { epoch: record.epoch, holderRef: record.holderRef },
      options.fetchImpl
    );
    writeA2ALeaseRecord(dir, {
      ...record,
      releasedAt:
        receipt.releasedAt ??
        (options.now ?? (() => new Date().toISOString()))(),
    });
    return {
      changed: receipt.changed !== false,
      outcome: "released",
      supervisorId: record.supervisorId,
    };
  } catch (error) {
    if (error instanceof A2AClientError && error.code === "lease-fenced") {
      return {
        outcome: "fenced",
        reason: String(error.detail?.reason ?? "fenced"),
        supervisorId: record.supervisorId,
      };
    }
    return {
      detail: error instanceof Error ? error.message : "release failed",
      outcome: "failed",
      supervisorId: record.supervisorId,
    };
  }
};

/** One teardown log line for a release outcome; undefined for no lease. */
export const describeA2ALeaseRelease = (
  outcome: A2ALeaseReleaseOutcome
): string | undefined => {
  switch (outcome.outcome) {
    case "none":
      return undefined;
    case "already-released":
      return `[loop] A2A endpoint of ${outcome.supervisorId} was already released`;
    case "released":
      return `[loop] released the A2A endpoint of ${outcome.supervisorId}`;
    case "fenced":
      return `[loop] A2A endpoint of ${outcome.supervisorId} is held by a newer claim (${outcome.reason}); nothing released`;
    default:
      return `[loop] A2A endpoint release failed${outcome.supervisorId ? ` for ${outcome.supervisorId}` : ""}: ${outcome.detail}; the lease lapses by its TTL`;
  }
};

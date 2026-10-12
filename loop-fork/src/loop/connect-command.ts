import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type A2AClientDeps,
  type A2AClientEndpoint,
  acknowledgeA2AWorkflows,
  claimA2ASession,
  clientTrust,
  readA2AClientConfig,
  releaseA2ASession,
  resolveA2AClientEndpoint,
} from "./a2a-session-client";
import { enrollA2ASession, fetchWithTrust } from "./a2a-session-credential";
import { claudeChannelNotification } from "./bridge-runtime";
import { readBridgeStatus } from "./bridge-store";
import { BridgeSupervisorMessageDeliveryPort } from "./bridge-supervisor-message-delivery";
import { injectCodexMessage } from "./codex-app-server";
import { LOOP_VERSION } from "./constants";
import { InboxStreamClient, type InboxStreamEnd } from "./inbox-stream-client";
import { type RunStorage, resolveRunStorage } from "./run-state";
import {
  requireLoopbackCodexRemoteUrl,
  requireSupervisorEndpointLeaseTtlMs,
  requireSupervisorEndpointRecipient,
  requireSupervisorEndpointRunId,
  requireSupervisorEndpointThreadId,
  type SupervisorEndpointInboxStreamLocator,
  type SupervisorEndpointLeaseFence,
} from "./supervisor-endpoint-lease";
import { supervisorSlug } from "./supervisor-id";
import type { SupervisorInboxEvent } from "./supervisor-inbox-stream";
import { SupervisorMessageV2BridgeDeliveryPort } from "./supervisor-message-v2-bridge-delivery";

/**
 * `loop connect`: an MCP server (stdio, newline-delimited JSON-RPC) that holds
 * one supervisor's outbound inbox stream (ra1) and delivers what arrives to
 * its own session, so a session behind NAT or on another device receives
 * without an inbound port.
 *
 *   loop connect --as supervisor:x --deliver claude --session <claude-session-id>
 *   loop connect --as supervisor:x --deliver codex  --thread <id> --codex-remote ws://127.0.0.1:<port>
 *   loop connect --as supervisor:x --deliver seat   --run <run-id> --seat claude|codex
 *                (each: [--takeover] [--ttl-ms <ms>] [--allow-multi-token-env]
 *                 [--enroll-code-file <path>] [--trust-file <ca.pem>])
 *
 * - ra2: the server is the config's own origin (https anywhere, or http on
 *   loopback). A session beyond loopback authenticates with its enrolled
 *   session token: `--enroll-code-file` exchanges a single-use code (read
 *   from the file, never argv) for one and keeps it as this supervisor's
 *   credential; later runs, and `loop a2a`, reuse it. This process keeps it
 *   fresh while it runs. A static tokenEnv token is only used on loopback.
 *   `--trust-file` names the PEM anchors of a private CA for an https origin.
 *
 * - Identity is fixed before any input is read: `--as`, its tokenEnv, and the
 *   fence of the inbox-stream lease this process claims (holderRef
 *   `connect:<uuid>`). Tool input never names an identity, a server or a
 *   path. A live lease of another holder is refused unless `--takeover`;
 *   losing the lease ends the stream (no automatic reclaim).
 * - Delivery by kind: Claude gets the bridge's `notifications/claude/channel`
 *   on this server's stdout (after `notifications/initialized`); Codex gets
 *   `injectCodexMessage` on a loopback app-server thread; a Loop run seat
 *   gets the run's bridge queue (the same V2 bridge port the server uses,
 *   deduplicated per message).
 * - The `inbox_ack` tool is the recipient's delivery/read ACK on the existing
 *   recipient route. It is never completion; nothing here publishes a result.
 * - The lease is kept alive by the server observing this stream; no renew
 *   loop and no polling. The lease is released when stdin ends, and on
 *   SIGTERM/SIGINT/SIGHUP (bounded), which is how Claude Code stops it.
 */
export const CONNECT_COMMAND = "connect";
/** How long a signalled connect waits for its lease release before exiting. */
const SIGNAL_RELEASE_TIMEOUT_MS = 3000;
export const ALLOW_MULTI_TOKEN_ENV_FLAG = "--allow-multi-token-env";

const USAGE = [
  "Usage: loop connect --as <supervisor:id> --deliver <claude|codex|seat> [--takeover] [--ttl-ms <ms>] [--allow-multi-token-env] [--enroll-code-file <path>] [--trust-file <ca.pem>] ...",
  "  --deliver claude --session <claude-session-id>",
  "  --deliver codex  --thread <thread-id> --codex-remote ws://127.0.0.1:<port>",
  "  --deliver seat   --run <run-id> --seat claude|codex",
].join("\n");

const VALUE_FLAGS = [
  "--as",
  "--codex-remote",
  "--deliver",
  "--enroll-code-file",
  "--run",
  "--seat",
  "--session",
  "--thread",
  "--trust-file",
  "--ttl-ms",
] as const;
const BOOLEAN_FLAGS = [ALLOW_MULTI_TOKEN_ENV_FLAG, "--takeover"] as const;

type DeliverKind = "claude" | "codex" | "seat";

export type ConnectTarget =
  | { kind: "claude"; sessionId: string }
  | { kind: "codex"; remoteUrl: string; threadId: string }
  | {
      kind: "seat";
      runDir: string;
      seat: "claude" | "codex";
      sessionId: string;
    };

export interface ConnectOptions {
  allowMultiTokenEnv: boolean;
  /** A file holding a single-use enrollment code (never the code itself). */
  enrollCodeFile?: string;
  supervisorId: string;
  takeover: boolean;
  target: ConnectTarget;
  /** PEM trust anchors for an https origin with a private CA. */
  trustFile?: string;
  ttlMs?: number;
}

const usageError = (detail?: string): Error =>
  new Error(detail ? `${detail}\n${USAGE}` : USAGE);

const parseFlags = (
  args: readonly string[]
): { booleans: Set<string>; values: Map<string, string> } => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index] ?? "";
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      booleans.add(name);
      continue;
    }
    const value = args[index + 1];
    if (
      !(VALUE_FLAGS as readonly string[]).includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      !value.trim()
    ) {
      throw usageError(`invalid argument: ${name}`);
    }
    if (values.has(name)) {
      throw usageError(`${name} given more than once`);
    }
    values.set(name, value);
    index++;
  }
  return { booleans, values };
};

export interface ConnectDeps extends A2AClientDeps {
  resolveRunStorage?: (runId: string) => RunStorage;
  seatSessionId?: (runDir: string, seat: "claude" | "codex") => string;
}

const defaultSeatSessionId = (
  runDir: string,
  seat: "claude" | "codex"
): string => {
  const status = readBridgeStatus(runDir);
  return seat === "claude" ? status.claudeSessionId : status.codexThreadId;
};

const ALLOWED_TARGET_FLAGS: Record<DeliverKind, readonly string[]> = {
  claude: ["--session"],
  codex: ["--codex-remote", "--thread"],
  seat: ["--run", "--seat"],
};
const COMMON_FLAGS = [
  "--as",
  "--deliver",
  "--enroll-code-file",
  "--trust-file",
  "--ttl-ms",
];

const seatTarget = (
  need: (name: string) => string,
  deps: ConnectDeps
): ConnectTarget => {
  const seat = need("--seat");
  if (seat !== "claude" && seat !== "codex") {
    throw usageError("--seat is claude or codex");
  }
  const storage = (deps.resolveRunStorage ?? resolveRunStorage)(
    requireSupervisorEndpointRunId(need("--run"))
  );
  if (!existsSync(storage.manifestPath)) {
    throw new Error(`run ${storage.runId} has no manifest`);
  }
  const sessionId = (deps.seatSessionId ?? defaultSeatSessionId)(
    storage.runDir,
    seat
  );
  if (!sessionId) {
    throw new Error(`run ${storage.runId} has no ${seat} session yet`);
  }
  return {
    kind: "seat",
    runDir: storage.runDir,
    seat,
    sessionId: requireSupervisorEndpointThreadId(sessionId),
  };
};

const connectTarget = (
  deliver: DeliverKind,
  values: Map<string, string>,
  deps: ConnectDeps
): ConnectTarget => {
  const need = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw usageError(`${name} is required with --deliver ${deliver}`);
    }
    return value;
  };
  if (deliver === "claude") {
    return {
      kind: "claude",
      sessionId: requireSupervisorEndpointThreadId(need("--session")),
    };
  }
  if (deliver === "codex") {
    return {
      kind: "codex",
      // Loopback only: this process dials the app-server it was given.
      remoteUrl: requireLoopbackCodexRemoteUrl(need("--codex-remote")),
      threadId: requireSupervisorEndpointThreadId(need("--thread")),
    };
  }
  return seatTarget(need, deps);
};

/** Strict argv decode; every id checked before anything is sent. */
export const parseConnectArgs = (
  argv: readonly string[],
  deps: ConnectDeps = {}
): ConnectOptions => {
  const [command, ...rest] = argv;
  if (command !== CONNECT_COMMAND) {
    throw usageError();
  }
  const { booleans, values } = parseFlags(rest);
  const as = values.get("--as");
  if (!as) {
    throw usageError("--as is required");
  }
  const supervisorId = requireSupervisorEndpointRecipient(as);
  const deliver = values.get("--deliver") as DeliverKind | undefined;
  if (!(deliver && deliver in ALLOWED_TARGET_FLAGS)) {
    throw usageError("--deliver is claude, codex or seat");
  }
  for (const name of values.keys()) {
    if (
      !(
        COMMON_FLAGS.includes(name) ||
        ALLOWED_TARGET_FLAGS[deliver].includes(name)
      )
    ) {
      throw usageError(`${name} is not used with --deliver ${deliver}`);
    }
  }
  const target = connectTarget(deliver, values, deps);
  const ttl = values.get("--ttl-ms");
  const enrollCodeFile = values.get("--enroll-code-file");
  const trustFile = values.get("--trust-file");
  return {
    allowMultiTokenEnv: booleans.has(ALLOW_MULTI_TOKEN_ENV_FLAG),
    ...(enrollCodeFile === undefined ? {} : { enrollCodeFile }),
    supervisorId,
    ...(trustFile === undefined ? {} : { trustFile }),
    takeover: booleans.has("--takeover"),
    target,
    ...(ttl === undefined
      ? {}
      : { ttlMs: requireSupervisorEndpointLeaseTtlMs(Number(ttl)) }),
  };
};

/** The inbox-stream locator a target claims: ids only. */
export const connectLocator = (
  target: ConnectTarget
): SupervisorEndpointInboxStreamLocator => {
  if (target.kind === "claude") {
    return {
      agent: "claude",
      kind: "inbox-stream",
      sessionId: target.sessionId,
    };
  }
  if (target.kind === "codex") {
    return { agent: "codex", kind: "inbox-stream", sessionId: target.threadId };
  }
  return {
    agent: target.seat,
    kind: "inbox-stream",
    sessionId: target.sessionId,
  };
};

/** What a provider session reads for one inbox message. */
export const formatInboxMessage = (event: SupervisorInboxEvent): string => {
  const { envelope } = event;
  return [
    `[loop A2A message ${envelope.messageId}, thread ${envelope.threadId}, to ${envelope.target}]`,
    envelope.body,
    ...(envelope.artifactRefs.length > 0
      ? ["", `Artifacts: ${envelope.artifactRefs.join(", ")}`]
      : []),
    "",
    `Acknowledge receipt (a read ACK, not completion) with the inbox_ack tool, workflow ${envelope.workflowId}.`,
  ].join("\n");
};

export type InboxDeliverer = (event: SupervisorInboxEvent) => Promise<boolean>;

/** Writes one JSON-RPC message as a line; resolves once it is flushed. */
export type JsonRpcWriter = (payload: unknown) => Promise<void>;

export const claudeChannelDeliverer =
  (supervisorId: string, write: JsonRpcWriter): InboxDeliverer =>
  async (event) => {
    await write(
      claudeChannelNotification({
        at: event.appendedAt,
        chatId: `a2a_${supervisorSlug(supervisorId)}`,
        content: formatInboxMessage(event),
        messageId: event.envelope.messageId,
        sourceType: "a2a",
        user: "A2A",
        userId: "a2a",
      })
    );
    return true;
  };

export const codexThreadDeliverer =
  (
    remoteUrl: string,
    threadId: string,
    inject: typeof injectCodexMessage = injectCodexMessage
  ): InboxDeliverer =>
  async (event) =>
    // Checked on every delivery, before anything is dialled.
    await inject(
      requireLoopbackCodexRemoteUrl(remoteUrl),
      threadId,
      formatInboxMessage(event)
    );

export const loopSeatDeliverer = (
  runDir: string,
  seat: "claude" | "codex"
): InboxDeliverer => {
  const port = new SupervisorMessageV2BridgeDeliveryPort(
    new BridgeSupervisorMessageDeliveryPort({
      directory: { resolve: () => ({ runDir, target: seat }) },
    })
  );
  return async (event) =>
    (await port.deliver(event.envelope)).status === "accepted";
};

/* ---------------------------------------------------------------------------
 * The MCP server.
 * ------------------------------------------------------------------------- */

interface JsonRpcMessage {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const MCP_METHOD_NOT_FOUND = -32_601;
const MCP_INVALID_PARAMS = -32_602;
const MAX_ACK_IDS = 100;

export const CONNECT_TOOLS = [
  {
    annotations: { destructiveHint: false, readOnlyHint: false },
    description:
      "Acknowledge receipt of inbox messages (a delivery/read ACK on the recipient route, never completion) by their workflow ids.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        workflow_ids: {
          items: { type: "string" },
          maxItems: MAX_ACK_IDS,
          minItems: 1,
          type: "array",
        },
      },
      required: ["workflow_ids"],
      type: "object",
    },
    name: "inbox_ack",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "This session's fixed identity, its lease fence and the last inbox sequence delivered.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    name: "inbox_status",
  },
] as const;

const connectInstructions = (supervisorId: string): string =>
  [
    `Messages addressed to ${supervisorId} arrive as <channel source="loop-connect" ...> notifications from its A2A inbox stream.`,
    "Each names a workflow id. After you have read a message, call inbox_ack with that workflow id: the ACK says you received it, not that the work is done.",
    "Acting on a message is separate work; never treat the ACK as completion.",
  ].join("\n");

export interface ConnectServerState {
  cursor(): number;
  endpoint: A2AClientEndpoint;
  fence: SupervisorEndpointLeaseFence;
  /** The identity named on the command line, fixed before stdin is read. */
  supervisorId: string;
}

/**
 * Answers one JSON-RPC request. Returns the response, or undefined for a
 * notification. Tool input never changes the identity or the server.
 */
export const handleConnectRequest = async (
  request: JsonRpcMessage,
  options: {
    channel: boolean;
    fetchImpl?: typeof fetch;
    state: ConnectServerState;
  }
): Promise<Record<string, unknown> | undefined> => {
  const { id, method } = request;
  if (id === undefined || id === null) {
    return undefined;
  }
  const result = (value: unknown) => ({ id, jsonrpc: "2.0", result: value });
  const error = (code: number, message: string) => ({
    error: { code, message },
    id,
    jsonrpc: "2.0",
  });
  const params =
    typeof request.params === "object" && request.params !== null
      ? (request.params as Record<string, unknown>)
      : {};
  switch (method) {
    case "initialize":
      return result({
        capabilities: options.channel
          ? { experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} }, tools: {} }
          : { tools: {} },
        ...(options.channel
          ? {
              instructions: connectInstructions(options.state.supervisorId),
            }
          : {}),
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05",
        serverInfo: { name: "loop-connect", version: LOOP_VERSION },
      });
    case "ping":
      return result({});
    case "prompts/list":
      return result({ prompts: [] });
    case "resources/list":
      return result({ resources: [] });
    case "resources/templates/list":
      return result({ resourceTemplates: [] });
    case "tools/list":
      return result({ tools: CONNECT_TOOLS });
    case "tools/call":
      return await callConnectTool(params, options, result, error);
    default:
      return error(MCP_METHOD_NOT_FOUND, `Unknown method: ${String(method)}`);
  }
};

const callConnectTool = async (
  params: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; state: ConnectServerState },
  result: (value: unknown) => Record<string, unknown>,
  error: (code: number, message: string) => Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const args =
    typeof params.arguments === "object" && params.arguments !== null
      ? (params.arguments as Record<string, unknown>)
      : {};
  const text = (value: unknown) =>
    result({
      content: [{ text: JSON.stringify(value, null, 2), type: "text" }],
    });
  if (params.name === "inbox_status") {
    return text({
      cursor: options.state.cursor(),
      epoch: options.state.fence.epoch,
      holderRef: options.state.fence.holderRef,
      supervisorId: options.state.endpoint.supervisorId,
    });
  }
  if (params.name !== "inbox_ack") {
    return error(MCP_INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
  }
  const ids = args.workflow_ids;
  if (
    !(
      Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= MAX_ACK_IDS &&
      ids.every((entry) => typeof entry === "string")
    ) ||
    Object.keys(args).some((key) => key !== "workflow_ids")
  ) {
    return error(MCP_INVALID_PARAMS, "workflow_ids must be 1-100 strings");
  }
  // The endpoint, and so the identity and the token, were fixed at start.
  try {
    return text(
      await acknowledgeA2AWorkflows(
        options.state.endpoint,
        [...new Set(ids as string[])],
        options.fetchImpl
      )
    );
  } catch (failure) {
    // A session that must enroll again: a tool error, never the server's end.
    return result({
      content: [
        {
          text: failure instanceof Error ? failure.message : "inbox_ack failed",
          type: "text",
        },
      ],
      isError: true,
    });
  }
};

/** Newline-delimited JSON-RPC frames from a byte stream. */
export async function* readJsonRpcLines(
  input: AsyncIterable<Uint8Array | string>
): AsyncGenerator<JsonRpcMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null) {
            yield parsed as JsonRpcMessage;
          }
        } catch {
          // Not JSON-RPC; ignored like any stray line.
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
}

export interface ConnectRuntime {
  /** Overrides the delivery by kind (tests). */
  deliverer?: InboxDeliverer;
  deps?: ConnectDeps;
  /** Overrides the configured server endpoint (tests). */
  endpoint?: A2AClientEndpoint;
  input?: AsyncIterable<Uint8Array | string>;
  log?: (line: string) => void;
  write?: JsonRpcWriter;
}

const stdoutWriter: JsonRpcWriter = (payload) =>
  new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, (error) =>
      error ? reject(error) : resolve()
    );
  });

const delivererFor = (
  target: ConnectTarget,
  supervisorId: string,
  write: JsonRpcWriter
): InboxDeliverer => {
  if (target.kind === "claude") {
    return claudeChannelDeliverer(supervisorId, write);
  }
  if (target.kind === "codex") {
    return codexThreadDeliverer(target.remoteUrl, target.threadId);
  }
  return loopSeatDeliverer(target.runDir, target.seat);
};

/**
 * ra2: exchanges the code in `--enroll-code-file` for this supervisor's
 * session credential at the config's origin. Only a role-bound address can
 * hold a session token, and the token must be for that role.
 */
const enrollConnectSession = async (
  options: ConnectOptions & { enrollCodeFile: string },
  deps: ConnectDeps,
  log: (line: string) => void
): Promise<void> => {
  const client = readA2AClientConfig(options.supervisorId, deps);
  if (!client.role) {
    throw new Error(
      `${client.supervisorId} has no role in the orchestration config; only a role-bound address can hold a session token`
    );
  }
  const uid = deps.uid?.();
  const trustCa = clientTrust(client.origin, options.trustFile, uid);
  const enrolled = await enrollA2ASession({
    codeFile: options.enrollCodeFile,
    ...(deps.env ? { env: deps.env } : {}),
    fetchImpl: fetchWithTrust(deps.fetchImpl ?? fetch, trustCa),
    ...(deps.nowMs ? { now: deps.nowMs } : {}),
    origin: client.origin,
    role: client.role,
    supervisorId: client.supervisorId,
    ...(uid === undefined ? {} : { uid }),
  });
  log(
    `[loop connect] enrolled ${client.supervisorId} at ${client.origin} (session ${enrolled.sessionId}, token until ${new Date(enrolled.expiresAt * 1000).toISOString()})`
  );
};

/** Claims this process's inbox-stream lease: a fresh holder, fixed fence. */
const claimInboxStream = async (
  endpoint: A2AClientEndpoint,
  options: ConnectOptions,
  deps: ConnectDeps,
  log: (line: string) => void
): Promise<SupervisorEndpointLeaseFence> => {
  const holderRef = `connect:${randomUUID()}`;
  const locator = connectLocator(options.target);
  const receipt = await claimA2ASession(
    endpoint,
    {
      holderRef,
      locator,
      sessionRef: `session:${locator.sessionId}`,
      ...(options.takeover ? { takeover: true } : {}),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    },
    deps.fetchImpl
  );
  log(
    `[loop connect] ${endpoint.supervisorId} holds its inbox stream (epoch ${receipt.epoch}${receipt.tookOver ? ", took over" : ""})`
  );
  return { epoch: receipt.epoch, holderRef };
};

/**
 * Serves MCP until stdin ends. `establish` (enroll, claim) runs once, before
 * the first request that needs the identity's server state: the client's
 * `notifications/initialized` or any tool call. `initialize` is answered from
 * the command line alone, so a client that probes the server and closes it
 * before the handshake completes (Claude Code does, then starts it again)
 * spends no enrollment code and holds no lease.
 */
const serveConnectMcp = async (input: {
  channel: boolean;
  establish(): Promise<void>;
  fetchImpl?: typeof fetch;
  onInitialized(): void;
  requests: AsyncIterable<Uint8Array | string>;
  state: ConnectServerState;
  write: JsonRpcWriter;
}): Promise<void> => {
  for await (const request of readJsonRpcLines(input.requests)) {
    if (request.method === "notifications/initialized") {
      await input.establish();
      input.onInitialized();
    } else if (request.method === "tools/call") {
      await input.establish();
    }
    const response = await handleConnectRequest(request, {
      channel: input.channel,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      state: input.state,
    });
    if (response) {
      await input.write(response);
    }
  }
};

/**
 * Runs `loop connect` until stdin ends: claim, stream, serve MCP, release.
 * Resolves with how the stream ended.
 */
export const runConnectCommand = async (
  argv: readonly string[],
  runtime: ConnectRuntime = {}
): Promise<{ end: InboxStreamEnd; released: boolean }> => {
  const deps = runtime.deps ?? {};
  const log = runtime.log ?? ((line: string) => console.error(line));
  const write = runtime.write ?? stdoutWriter;
  const options = parseConnectArgs(argv, deps);
  const clientDeps: ConnectDeps = {
    ...deps,
    allowMultiTokenEnv: options.allowMultiTokenEnv,
    log,
    ...(options.trustFile === undefined
      ? {}
      : { trustFile: options.trustFile }),
  };
  // Identity first: the supervisor id comes from the command line and the
  // endpoint from the local config and credential, never from stdin.
  const abort = new AbortController();
  let established:
    | {
        client: InboxStreamClient;
        endpoint: A2AClientEndpoint;
        fence: SupervisorEndpointLeaseFence;
      }
    | undefined;
  let establishing: Promise<void> | undefined;
  const establish = (): Promise<void> => {
    establishing ??= (async () => {
      if (options.enrollCodeFile !== undefined && !runtime.endpoint) {
        await enrollConnectSession(
          { ...options, enrollCodeFile: options.enrollCodeFile },
          clientDeps,
          log
        );
      }
      const endpoint =
        runtime.endpoint ??
        resolveA2AClientEndpoint(options.supervisorId, clientDeps);
      if (endpoint.supervisorId !== options.supervisorId) {
        throw new Error("connect endpoint does not act as --as");
      }
      const fence = await claimInboxStream(endpoint, options, deps, log);
      // A session token is refreshed ahead of expiry while this process
      // runs, so every reconnect presents a valid one.
      endpoint.keepFresh(abort.signal, (error) =>
        log(`[loop connect] session token: ${error.message}`)
      );
      const client = new InboxStreamClient({
        deliver:
          runtime.deliverer ??
          delivererFor(options.target, endpoint.supervisorId, write),
        endpoint,
        fence,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        log,
        signal: abort.signal,
      });
      established = { client, endpoint, fence };
    })();
    return establishing;
  };
  const current = () => {
    if (!established) {
      throw new Error("loop connect: the session is not established");
    }
    return established;
  };
  const state: ConnectServerState = {
    cursor: () => established?.client.cursor ?? 0,
    get endpoint() {
      return current().endpoint;
    },
    get fence() {
      return current().fence;
    },
    supervisorId: options.supervisorId,
  };
  let stream: Promise<InboxStreamEnd> | undefined;
  const startStream = () => {
    stream ??= current()
      .client.run()
      .then((end) => {
        if (end.reason !== "aborted") {
          log(`[loop connect] inbox stream ended: ${end.reason}`);
        }
        return end;
      });
  };
  const channel = options.target.kind === "claude";
  // Claude Code ends an MCP server with a signal, not by closing stdin, so a
  // session that exits or crashes would leave its lease held until the TTL
  // lapses and the next session's claim refused (lease-held). Release first,
  // bounded, then exit. Only for the real process: tests feed their own input.
  const releaseOnSignal = () => {
    abort.abort();
    const held = established;
    const done = () => process.exit(0);
    if (!held) {
      done();
      return;
    }
    setTimeout(done, SIGNAL_RELEASE_TIMEOUT_MS).unref?.();
    releaseA2ASession(held.endpoint, held.fence, deps.fetchImpl).then(
      done,
      done
    );
  };
  const signals = runtime.input
    ? []
    : (["SIGTERM", "SIGINT", "SIGHUP"] as const);
  for (const signal of signals) {
    process.once(signal, releaseOnSignal);
  }
  if (!channel) {
    // A Codex thread or a run seat: no MCP handshake gates the stream.
    await establish();
    startStream();
  }
  try {
    await serveConnectMcp({
      channel,
      establish,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      // Channel notifications only once the client is ready for them.
      onInitialized: startStream,
      requests: runtime.input ?? process.stdin,
      state,
      write,
    });
  } finally {
    abort.abort();
    for (const signal of signals) {
      process.off(signal, releaseOnSignal);
    }
  }
  const end = (await stream) ?? { reason: "aborted" as const };
  if (!established) {
    // Closed before the handshake completed: nothing was claimed.
    return { end, released: false };
  }
  try {
    await releaseA2ASession(
      established.endpoint,
      established.fence,
      deps.fetchImpl
    );
    return { end, released: true };
  } catch {
    // A fenced lease (taken over) is not this holder's to release.
    log("[loop connect] lease release refused or unavailable");
    return { end, released: false };
  }
};

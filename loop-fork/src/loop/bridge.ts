import { mkdirSync, watch } from "node:fs";
import { basename } from "node:path";
import { claudeChannelServerName } from "./bridge-config";
import { BRIDGE_SERVER as BRIDGE_SERVER_VALUE } from "./bridge-constants";
import {
  consumeBridgeInbox,
  dispatchBridgeMessage,
  formatDispatchResult,
  type ImmediateBridgeDelivery,
} from "./bridge-dispatch";
import { claudeChannelInstructions } from "./bridge-guidance";
import {
  bridgeRuntimeCommandDeps,
  clearStaleTmuxBridgeState,
  deliverCodexBridgeMessage,
  deliverTmuxBridgeMessage,
  drainCodexTmuxMessages,
  ensureBridgeWorker,
  flushClaudeChannelMessages,
  hasBridgeDeliveryRoute,
  readBridgeRuntimeStatus,
} from "./bridge-runtime";
import {
  appendBlockedBridgeMessage,
  appendBridgeEvent,
  type BridgeEnqueueOptions,
  type BridgeMessageType,
  type BridgePriority,
  blocksBridgeBounce,
  bridgePath,
  formatBridgeInbox,
  normalizeAgent,
  readBridgeEvents,
} from "./bridge-store";
import {
  callUtilityBridgeTool,
  isUtilityBridgeToolName,
  UTILITY_BRIDGE_TOOLS,
  UtilityBridgeInputError,
} from "./bridge-utility";
import { LOOP_VERSION } from "./constants";
import type { Agent } from "./types";

type BridgeMcpSource = Agent | "supervisor";

const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CLAUDE_CHANNEL_FALLBACK_SWEEP_MS = 2000;
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const CONTENT_LENGTH_PREFIX = "content-length:";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const HEADER_SEPARATOR = "\r\n\r\n";
const MCP_INVALID_PARAMS = -32_602;
const MCP_METHOD_NOT_FOUND = -32_601;
const MUTATING_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const RECEIVE_MESSAGES_TOOL_ANNOTATIONS = {
  destructiveHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};
const READ_ONLY_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: true,
};

interface BridgeCallParams {
  arguments?: Record<string, unknown>;
  name?: string;
}

interface JsonRpcRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const normalizeLowerString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
};

const bridgeMessageType = (value: unknown): BridgeMessageType | undefined => {
  const normalized = normalizeLowerString(value);
  return normalized === "message" ||
    normalized === "work_request" ||
    normalized === "review_request" ||
    normalized === "decision" ||
    normalized === "handover" ||
    normalized === "escalation" ||
    normalized === "ack"
    ? normalized
    : undefined;
};

const bridgePriority = (value: unknown): BridgePriority | undefined => {
  const normalized = normalizeLowerString(value);
  return normalized === "low" ||
    normalized === "normal" ||
    normalized === "high" ||
    normalized === "urgent"
    ? normalized
    : undefined;
};

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;

const bridgeEnqueueOptions = (
  args: Record<string, unknown>,
  type: BridgeMessageType | undefined,
  priority: BridgePriority | undefined
): BridgeEnqueueOptions => {
  const artifactRefs = stringArray(args.artifact_refs);
  const dedupeKey = asString(args.dedupe_key);
  const replyTo = asString(args.reply_to);
  const subject = asString(args.subject);
  const taskId = asString(args.task_id);
  const threadId = asString(args.thread_id);
  return {
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(priority ? { priority } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(subject ? { subject } : {}),
    ...(args.supersede === true ? { supersede: true } : {}),
    ...(taskId ? { taskId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(typeof args.ttl_ms === "number" ? { ttlMs: args.ttl_ms } : {}),
    ...(type ? { type } : {}),
  };
};

export const immediateBridgeDelivery = (
  runDir: string,
  target: Agent
): ImmediateBridgeDelivery | undefined => {
  if (target === "codex") {
    return async (entry) => {
      if (readBridgeRuntimeStatus(runDir).codexDeliveryMode === "tmux-proxy") {
        return false;
      }
      return (
        (await deliverCodexBridgeMessage(runDir, entry)) ||
        (await deliverTmuxBridgeMessage(runDir, entry))
      );
    };
  }
  if (
    target === "claude" ||
    target === "cursor" ||
    target === "gemini" ||
    target === "copilot"
  ) {
    return (entry) => deliverTmuxBridgeMessage(runDir, entry);
  }
  return undefined;
};

// This bridge is launched under the agent CLIs' stdio MCP hooks, but those
// runtimes expect newline-delimited JSON here so async channel notifications can
// be pushed without Content-Length framing.
const writeJsonRpc = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const writeError = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string
): void => {
  writeJsonRpc({
    error: { code, message },
    id,
    jsonrpc: "2.0",
  });
};

const toolContent = (
  text: string
): { content: Array<{ text: string; type: string }> } => ({
  content: [{ text, type: "text" }],
});

const emptyResult = (id: JsonRpcRequest["id"], key: string): void => {
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: { [key]: [] },
  });
};

const handleBridgeStatusTool = (
  id: JsonRpcRequest["id"],
  runDir: string
): void => {
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(
      JSON.stringify(readBridgeRuntimeStatus(runDir), null, 2)
    ),
  });
};

const handleReceiveMessagesTool = (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: Agent
): void => {
  const messages = consumeBridgeInbox(
    runDir,
    source,
    "read via receive_messages"
  );
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(
      messages.length === 0 ? "[]" : formatBridgeInbox(messages)
    ),
  });
};

const handleSendMessageTool = async (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: BridgeMcpSource,
  args: Record<string, unknown>
): Promise<void> => {
  const normalizedTarget = normalizeLowerString(args.target);
  const message = asString(args.message);
  const type = bridgeMessageType(args.type);
  const priority = bridgePriority(args.priority);
  if (!normalizedTarget) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_message requires a non-empty target"
    );
    return;
  }
  const target = normalizeAgent(normalizedTarget);
  if (!target) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      `Unknown target "${normalizedTarget}" - expected one of "claude", "codex", "gemini", "cursor", or "copilot"`
    );
    return;
  }
  if (!message) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_message requires a non-empty message"
    );
    return;
  }
  if (target === source) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_message cannot target the current agent"
    );
    return;
  }

  if (args.type !== undefined && !type) {
    writeError(id, MCP_INVALID_PARAMS, "send_message received an invalid type");
    return;
  }
  if (args.priority !== undefined && !priority) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_message received an invalid priority"
    );
    return;
  }
  if (
    args.ttl_ms !== undefined &&
    (typeof args.ttl_ms !== "number" ||
      !Number.isFinite(args.ttl_ms) ||
      args.ttl_ms <= 0)
  ) {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      "send_message ttl_ms must be a positive number"
    );
    return;
  }

  const options = bridgeEnqueueOptions(args, type, priority);

  if (blocksBridgeBounce(runDir, source, target, message)) {
    appendBlockedBridgeMessage(
      runDir,
      source,
      target,
      message,
      "duplicate bridge message"
    );
    writeJsonRpc({
      id,
      jsonrpc: "2.0",
      result: toolContent("suppressed duplicate bridge message"),
    });
    return;
  }

  const result = await dispatchBridgeMessage(
    runDir,
    source,
    target,
    message,
    immediateBridgeDelivery(runDir, target),
    undefined,
    options
  );
  if (
    result.status === "queued" &&
    hasBridgeDeliveryRoute(runDir, target) &&
    ensureBridgeWorker(runDir)
  ) {
    result.status = "accepted";
  }
  writeJsonRpc({
    id,
    jsonrpc: "2.0",
    result: toolContent(formatDispatchResult(result)),
  });
};

const handleToolCall = async (
  id: JsonRpcRequest["id"],
  runDir: string,
  source: BridgeMcpSource,
  params: unknown
): Promise<void> => {
  const call = isRecord(params) ? (params as BridgeCallParams) : undefined;
  const name = call?.name;
  const args = isRecord(call?.arguments) ? call.arguments : {};

  if (name === "bridge_status") {
    handleBridgeStatusTool(id, runDir);
    return;
  }

  if (name === "receive_messages") {
    if (source === "supervisor") {
      writeError(
        id,
        MCP_INVALID_PARAMS,
        "supervisor bridge sessions cannot receive agent inbox messages"
      );
      return;
    }
    handleReceiveMessagesTool(id, runDir, source);
    return;
  }

  if (name === "send_to_agent") {
    writeError(
      id,
      MCP_INVALID_PARAMS,
      'Unknown tool: send_to_agent. Use "send_message" instead.'
    );
    return;
  }

  if (isUtilityBridgeToolName(name)) {
    try {
      const result = await callUtilityBridgeTool(
        name,
        runDir,
        source,
        args
      );
      writeJsonRpc({
        id,
        jsonrpc: "2.0",
        result: toolContent(JSON.stringify(result, null, 2)),
      });
    } catch (error) {
      writeError(
        id,
        MCP_INVALID_PARAMS,
        error instanceof UtilityBridgeInputError
          ? error.message
          : "utility task request failed"
      );
    }
    return;
  }

  if (name !== "send_message") {
    writeError(id, MCP_INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }

  await handleSendMessageTool(id, runDir, source, args);
};

const requestedProtocolVersion = (request: JsonRpcRequest): string =>
  asString((request.params as Record<string, unknown>)?.protocolVersion) ??
  DEFAULT_PROTOCOL_VERSION;

const handleBridgeRequest = async (
  runDir: string,
  source: BridgeMcpSource,
  request: JsonRpcRequest
): Promise<void> => {
  switch (request.method) {
    case "initialize":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities:
            source === "claude"
              ? {
                  experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} },
                  tools: {},
                }
              : { tools: {} },
          ...(source === "claude"
            ? { instructions: claudeChannelInstructions() }
            : {}),
          protocolVersion: requestedProtocolVersion(request),
          serverInfo: {
            name: BRIDGE_SERVER_VALUE,
            version: LOOP_VERSION,
          },
        },
      });
      return;
    case "ping":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {},
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "prompts/list":
      emptyResult(request.id, "prompts");
      return;
    case "resources/list":
      emptyResult(request.id, "resources");
      return;
    case "resources/templates/list":
      emptyResult(request.id, "resourceTemplates");
      return;
    case "tools/list":
      writeJsonRpc({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            ...UTILITY_BRIDGE_TOOLS,
            {
              annotations: MUTATING_TOOL_ANNOTATIONS,
              description: "Send a direct message to the paired agent.",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  artifact_refs: {
                    items: { type: "string" },
                    type: "array",
                  },
                  dedupe_key: { type: "string" },
                  message: { type: "string" },
                  priority: {
                    enum: ["low", "normal", "high", "urgent"],
                    type: "string",
                  },
                  reply_to: { type: "string" },
                  subject: { type: "string" },
                  supersede: { type: "boolean" },
                  task_id: { type: "string" },
                  target: {
                    enum: ["claude", "codex", "gemini", "cursor", "copilot"],
                    type: "string",
                  },
                  thread_id: { type: "string" },
                  ttl_ms: { minimum: 1, type: "number" },
                  type: {
                    enum: [
                      "message",
                      "work_request",
                      "review_request",
                      "decision",
                      "handover",
                      "escalation",
                      "ack",
                    ],
                    type: "string",
                  },
                },
                required: ["target", "message"],
                type: "object",
              },
              name: "send_message",
            },
            {
              annotations: READ_ONLY_TOOL_ANNOTATIONS,
              description:
                "Inspect the current paired run and pending bridge state when delivery looks stuck.",
              inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              name: "bridge_status",
            },
            {
              annotations: RECEIVE_MESSAGES_TOOL_ANNOTATIONS,
              description:
                "Read and clear pending bridge messages addressed to you when delivery looks stuck.",
              inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              name: "receive_messages",
            },
          ],
        },
      });
      return;
    case "tools/call":
      await handleToolCall(request.id, runDir, source, request.params);
      return;
    default:
      if (request.method?.startsWith("notifications/")) {
        return;
      }
      writeError(
        request.id,
        MCP_METHOD_NOT_FOUND,
        `Unsupported method: ${request.method}`
      );
  }
};

const readContentLength = (
  buffer: Buffer
): { bodyStart: number; length: number } | undefined => {
  const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
  if (headerEnd < 0) {
    return undefined;
  }
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const length = Number.parseInt(
    header.match(CONTENT_LENGTH_RE)?.[1] ?? "",
    10
  );
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("Invalid MCP frame header");
  }
  return {
    bodyStart: headerEnd + HEADER_SEPARATOR.length,
    length,
  };
};

const shiftContentLengthFrame = (
  buffer: Buffer
): [JsonRpcRequest | undefined, Buffer] => {
  const frame = readContentLength(buffer);
  if (!frame) {
    return [undefined, buffer];
  }
  const bodyEnd = frame.bodyStart + frame.length;
  if (buffer.length < bodyEnd) {
    return [undefined, buffer];
  }
  const body = buffer.subarray(frame.bodyStart, bodyEnd).toString("utf8");
  return [JSON.parse(body) as JsonRpcRequest, buffer.subarray(bodyEnd)];
};

const shiftLineFrame = (
  buffer: Buffer
): [JsonRpcRequest | undefined, Buffer] => {
  const newlineIndex = buffer.indexOf("\n");
  if (newlineIndex < 0) {
    return [undefined, buffer];
  }
  const next = buffer.subarray(newlineIndex + 1);
  const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
  if (!line) {
    return [undefined, next];
  }
  return [JSON.parse(line) as JsonRpcRequest, next];
};

const isContentLengthFrame = (buffer: Buffer): boolean => {
  const header = buffer
    .subarray(0, Math.min(buffer.length, CONTENT_LENGTH_PREFIX.length))
    .toString("utf8")
    .toLowerCase();
  return header === CONTENT_LENGTH_PREFIX;
};

const shiftFrame = (buffer: Buffer): [JsonRpcRequest | undefined, Buffer] => {
  if (isContentLengthFrame(buffer)) {
    return shiftContentLengthFrame(buffer);
  }
  return shiftLineFrame(buffer);
};

const asBuffer = (chunk: Buffer | string): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");

const drainBufferedFrames = (
  input: Buffer,
  onMessage: (request: JsonRpcRequest) => void
): Buffer => {
  let buffer = input;
  while (true) {
    const current = buffer;
    const [message, next] = shiftFrame(buffer);
    if (!message && next === current) {
      return buffer;
    }
    buffer = next;
    if (message) {
      onMessage(message);
    }
  }
};

const consumeFrames = (
  onMessage: (request: JsonRpcRequest) => void,
  onEnd?: () => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer | string): void => {
      try {
        buffer = drainBufferedFrames(
          Buffer.concat([buffer, asBuffer(chunk)]),
          onMessage
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", () => {
      onEnd?.();
      resolve();
    });
    process.stdin.on("error", reject);
  });

const isBridgeWatchEvent = (
  runDir: string,
  filename: string | Buffer | null
): boolean => {
  if (!filename) {
    return true;
  }
  return filename.toString() === basename(bridgePath(runDir));
};

export const runBridgeMcpServer = async (
  runDir: string,
  source: BridgeMcpSource
): Promise<void> => {
  let channelReady = false;
  let bridgeWatcher: { close: () => void } | undefined;
  let closed = false;
  let fallbackSweep: ReturnType<typeof setTimeout> | undefined;
  let flushQueue: Promise<void> = Promise.resolve();
  let requestQueue: Promise<void> = Promise.resolve();
  const queueClaudeFlush = (): Promise<void> => {
    if (!(source === "claude" && channelReady)) {
      return Promise.resolve();
    }
    const next = (): void => {
      flushClaudeChannelMessages(runDir, writeJsonRpc);
    };
    flushQueue = flushQueue.then(next, next);
    return flushQueue;
  };

  const triggerClaudeFlush = (): void => {
    queueClaudeFlush().catch(() => undefined);
  };

  const clearClaudeSweep = (): void => {
    if (!fallbackSweep) {
      return;
    }
    clearTimeout(fallbackSweep);
    fallbackSweep = undefined;
  };

  const scheduleClaudeSweep = (): void => {
    if (!(source === "claude" && channelReady) || closed || fallbackSweep) {
      return;
    }
    fallbackSweep = setTimeout(() => {
      fallbackSweep = undefined;
      if (closed) {
        return;
      }
      triggerClaudeFlush();
      scheduleClaudeSweep();
    }, CLAUDE_CHANNEL_FALLBACK_SWEEP_MS);
    fallbackSweep.unref?.();
  };

  if (source === "claude") {
    mkdirSync(runDir, { recursive: true });
    try {
      bridgeWatcher = watch(runDir, (_eventType, filename) => {
        if (!isBridgeWatchEvent(runDir, filename)) {
          return;
        }
        triggerClaudeFlush();
      });
    } catch {
      bridgeWatcher = undefined;
    }
  }

  process.stdin.resume();
  try {
    await consumeFrames(
      (request) => {
        const handleRequest = async (): Promise<void> => {
          if (request.method === "notifications/initialized") {
            channelReady = true;
            scheduleClaudeSweep();
          }
          await handleBridgeRequest(runDir, source, request);
          await queueClaudeFlush();
        };
        requestQueue = requestQueue.then(handleRequest, handleRequest);
      },
      () => {
        closed = true;
      }
    );
  } finally {
    closed = true;
    bridgeWatcher?.close();
    clearClaudeSweep();
  }

  await requestQueue;
  await queueClaudeFlush();
};

export const bridgeInternals = {
  appendBridgeEvent,
  bridgePath,
  clearStaleTmuxBridgeState,
  claudeChannelServerName,
  commandDeps: bridgeRuntimeCommandDeps,
  drainCodexTmuxMessages,
  deliverTmuxBridgeMessage,
  deliverCodexBridgeMessage,
  ensureBridgeWorker,
  hasBridgeDeliveryRoute,
  readBridgeEvents,
};

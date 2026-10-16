import { spawn, spawnSync } from "bun";
import {
  AGENT_TURN_TIMEOUT_MS,
  DEFAULT_CODEX_REASONING_EFFORT,
  LOOP_VERSION,
} from "./constants";
import { findFreePort } from "./ports";
import { DETACH_CHILD_PROCESS, killChildProcess } from "./process";
import type { Options, RunResult } from "./types";
import type { ConnectWsOptions } from "./ws-client";

type ExitSignal = "SIGINT" | "SIGTERM";
type TransportMode = "app-server" | "exec";
type Callback = (text: string) => void;
export interface AppServerLaunchOptions {
  configValues?: string[];
  env?: NodeJS.ProcessEnv;
  orphanOnExit?: boolean;
  persistentThread?: boolean;
  resumeThreadId?: string;
  threadModel?: string;
}
interface RunCodexTurnCallbacks {
  onParsed?: Callback;
  onRaw: Callback;
}

interface JsonFrame {
  error?: unknown;
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingTurnCompletion {
  reject: (error: Error) => void;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TurnState {
  activeItemAggregate: string;
  activeItemHasDelta: boolean;
  activeItemId: string;
  combined: string;
  completedItems: Map<string, string>;
  onParsed: Callback;
  onRaw: Callback;
  parsed: string;
  pendingMessageBreak: boolean;
  reject: (error: Error) => void;
  resolve: (result: RunResult) => void;
  threadId: string;
  turnId: string;
}

const APP_SERVER_CMD = "codex";
const APP_SERVER_BASE_PORT = 4500;
const APP_SERVER_PORT_RANGE = 100;
const WS_CONNECT_ATTEMPTS = 40;
const WS_CONNECT_DELAY_MS = 150;
const USER_INPUT_TEXT_ELEMENTS = "text_elements";
const NOOP_CALLBACK: Callback = () => undefined;
const WHITESPACE_RE = /\s+/;

export const CODEX_TRANSPORT_APP_SERVER: TransportMode = "app-server";
export const CODEX_TRANSPORT_EXEC: TransportMode = "exec";
export const CODEX_TRANSPORT_ENV = "CODEX_TRANSPORT";
export const DEFAULT_CODEX_TRANSPORT: TransportMode =
  CODEX_TRANSPORT_APP_SERVER;

const METHOD_INITIALIZE = "initialize";
const METHOD_INITIALIZED = "initialized";
const METHOD_THREAD_START = "thread/start";
const METHOD_THREAD_READ = "thread/read";
const METHOD_THREAD_RESUME = "thread/resume";
const METHOD_TURN_START = "turn/start";
const METHOD_TURN_STEER = "turn/steer";
const METHOD_TURN_COMPLETED = "turn/completed";
const METHOD_ERROR = "error";
const METHOD_ITEM_COMPLETED = "item/completed";
const METHOD_ITEM_DELTA = "item/agentMessage/delta";
const METHOD_COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const METHOD_FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";
const METHOD_TOOL_USER_INPUT = "item/tool/requestUserInput";
const METHOD_TOOL_CALL = "item/tool/call";
const METHOD_APPLY_PATCH_APPROVAL = "applyPatchApproval";
const METHOD_EXEC_COMMAND_APPROVAL = "execCommandApproval";
const METHOD_AUTH_REFRESH = "account/chatgptAuthTokens/refresh";
const METHODS_TRIGGERING_FALLBACK = new Set([
  METHOD_INITIALIZE,
  METHOD_THREAD_START,
  METHOD_TURN_START,
]);
const BRIDGE_OPT_OUT_NOTIFICATION_METHODS = [
  METHOD_ITEM_COMPLETED,
  METHOD_ITEM_DELTA,
] as const;

type SpawnFn = (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>;
type ConnectWsFn = (
  url: string,
  options?: ConnectWsOptions
) => Promise<import("./ws-client").WsClient>;
type ListenerOwnerPidFn = (port: number) => number | undefined;

let spawnFn: SpawnFn = spawn;
const defaultConnectWs: ConnectWsFn = async (url, options) => {
  const { connectWs } = await import("./ws-client");
  return connectWs(url, options);
};
let connectWsFn: ConnectWsFn = defaultConnectWs;
const defaultListenerOwnerPid: ListenerOwnerPidFn = (port) => {
  const result = spawnSync(
    ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const pids = new TextDecoder()
    .decode(result.stdout)
    .split(WHITESPACE_RE)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return pids.length === 1 ? pids[0] : undefined;
};
let listenerOwnerPidFn: ListenerOwnerPidFn = defaultListenerOwnerPid;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const asString = (value: unknown): string | undefined =>
  isString(value) ? value : undefined;
const normalizeConfigValues = (values: string[] = []): string[] => {
  const normalized: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value) {
      continue;
    }
    if (value === "-c") {
      const next = values[index + 1];
      if (next) {
        normalized.push(next);
      }
      index += 1;
      continue;
    }
    normalized.push(value);
  }

  return normalized;
};
const sameConfigValues = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
const asRequestId = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return isString(value) ? value : undefined;
};

const parseLine = (line: string): JsonFrame | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as JsonFrame) : undefined;
  } catch {
    return undefined;
  }
};

const collectText = (value: unknown, out: string[]): void => {
  if (isString(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const record = asRecord(value);
  const direct = asString(record.text) || asString(record.delta);
  if (direct) {
    out.push(direct);
  }
  collectText(record.content, out);
  collectText(record.item, out);
  collectText(record.payload, out);
};

const parseText = (value: unknown): string | undefined => {
  const parts: string[] = [];
  collectText(value, parts);
  return parts.length > 0
    ? parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n")
    : undefined;
};

const parseAgentMessageText = (
  item: Record<string, unknown>
): string | undefined => {
  const parts: string[] = [];
  const direct = asString(item.text);
  if (direct) {
    parts.push(direct);
  }
  const content = item.content;
  if (isString(content)) {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isString(part)) {
        parts.push(part);
        continue;
      }
      const record = asRecord(part);
      const keys = Object.keys(record);
      const text = asString(record.text);
      if (keys.length === 1 && keys[0] === "text" && text) {
        parts.push(text);
      }
    }
  }
  const text = parts.join("").trim();
  return text || undefined;
};

const isUnsupportedTransportError = (error: unknown): boolean => {
  const message = parseErrorText(error)?.toLowerCase();
  return (
    !!message &&
    (message.includes("unsupported") ||
      message.includes("method not found") ||
      message.includes("unknown method") ||
      message.includes("unsupported transport"))
  );
};

const parseErrorText = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const errorRecord = asRecord(record.error);
  const turn = asRecord(record.turn);
  const turnError = asRecord(turn.error);
  return (
    asString(errorRecord.message) ||
    asString(record.message) ||
    asString(record.reason) ||
    asString(turnError.message)
  );
};

/**
 * App-server read errors for a real thread that is not resident: evicted
 * from memory, or not materialized because it has no rollout yet.
 */
const isThreadNotLoadedError = (value: unknown): boolean => {
  const message = parseErrorText(value)?.toLowerCase();
  return !!(
    message &&
    (message.includes("thread not loaded") ||
      message.includes("no rollout found") ||
      message.includes("not materialized yet"))
  );
};

const isBusyTurnError = (value: unknown): boolean => {
  const message = parseErrorText(value)?.toLowerCase();
  return !!(
    message &&
    (message.includes("active turn") ||
      message.includes("already active") ||
      message.includes("busy") ||
      message.includes("in progress") ||
      message.includes("turn still active"))
  );
};

interface NormalizedIdentity {
  conflict: boolean;
  threadId?: string;
  turnId?: string;
}

const normalizeAliasedIdentity = (
  fields: [Record<string, unknown>, string][]
): { conflict: boolean; value?: string } => {
  const values: string[] = [];
  for (const [record, key] of fields) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }
    const value = asString(record[key]);
    if (!value) {
      return { conflict: true };
    }
    values.push(value);
  }
  const distinct = new Set(values);
  if (distinct.size > 1) {
    return { conflict: true };
  }
  return { conflict: false, value: values[0] };
};

const normalizeIdentity = (value: unknown): NormalizedIdentity => {
  const record = asRecord(value);
  const turn = asRecord(record.turn);
  const normalizedTurn = normalizeAliasedIdentity([
    [record, "turnId"],
    [record, "turn_id"],
    [turn, "id"],
  ]);
  const normalizedThread = normalizeAliasedIdentity([
    [record, "threadId"],
    [record, "thread_id"],
  ]);
  return {
    conflict: normalizedTurn.conflict || normalizedThread.conflict,
    threadId: normalizedThread.value,
    turnId: normalizedTurn.value,
  };
};

const NESTED_IDENTITY_DEPTH_LIMIT = 32;
const THREAD_ALIASES = ["threadId", "thread_id"];
const TURN_ALIASES = ["turnId", "turn_id"];

const aliasesMatch = (
  record: Record<string, unknown>,
  keys: string[],
  expected: string
): boolean =>
  keys.every((key) => !Object.hasOwn(record, key) || record[key] === expected);

const nestedIdMatches = (
  record: Record<string, unknown>,
  key: string,
  expected: string
): boolean => {
  if (!Object.hasOwn(record, key)) {
    return true;
  }
  const nested = record[key];
  if (!(isRecord(nested) && Object.hasOwn(nested, "id"))) {
    return true;
  }
  return nested.id === expected;
};

/**
 * Every thread/turn identity alias anywhere inside a notification payload,
 * including its item and nested records, must name the exact owned turn.
 * Outer params alone cannot attribute an item that carries another identity.
 */
const ownsNestedIdentity = (
  value: unknown,
  owner: { threadId: string; turnId: string },
  depth = 0
): boolean => {
  if (depth > NESTED_IDENTITY_DEPTH_LIMIT) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => ownsNestedIdentity(entry, owner, depth + 1));
  }
  if (!isRecord(value)) {
    return true;
  }
  if (
    !(
      aliasesMatch(value, THREAD_ALIASES, owner.threadId) &&
      aliasesMatch(value, TURN_ALIASES, owner.turnId) &&
      nestedIdMatches(value, "thread", owner.threadId) &&
      nestedIdMatches(value, "turn", owner.turnId)
    )
  ) {
    return false;
  }
  return Object.values(value).every((entry) =>
    ownsNestedIdentity(entry, owner, depth + 1)
  );
};

const extractTurnId = (value: unknown): string | undefined => {
  const identity = normalizeIdentity(value);
  return identity.conflict ? undefined : identity.turnId;
};

const extractThreadId = (value: unknown): string | undefined => {
  const identity = normalizeIdentity(value);
  return identity.conflict ? undefined : identity.threadId;
};

const normalizeItemId = (
  params: Record<string, unknown>,
  item: Record<string, unknown> = {}
): { conflict: boolean; value?: string } =>
  normalizeAliasedIdentity([
    [params, "itemId"],
    [params, "item_id"],
    [params, "id"],
    [item, "id"],
  ]);

const isSameActiveItem = (
  state: TurnState,
  itemId: string | undefined
): boolean =>
  state.activeItemHasDelta &&
  ((Boolean(itemId) && itemId === state.activeItemId) ||
    !(itemId || state.activeItemId));

const completedItemProjection = (
  state: TurnState,
  itemId: string | undefined,
  candidate: string
): { needsBoundary: boolean; suffix: string } => {
  const sameItem = isSameActiveItem(state, itemId);
  const normalizedAggregate = state.activeItemAggregate.trim();
  if (sameItem && candidate === normalizedAggregate) {
    return { needsBoundary: false, suffix: "" };
  }
  const aggregatePrefix = candidate.startsWith(state.activeItemAggregate)
    ? state.activeItemAggregate
    : normalizedAggregate;
  const continuesAggregate =
    sameItem &&
    Boolean(aggregatePrefix) &&
    candidate.startsWith(aggregatePrefix);
  return {
    needsBoundary: !continuesAggregate,
    suffix: continuesAggregate
      ? candidate.slice(aggregatePrefix.length)
      : candidate,
  };
};

const extractThreadFromTurnStart = (value: unknown): { id?: string } => {
  const record = asRecord(value);
  const thread = asRecord(record.thread);
  return { id: asString(thread.id) };
};

const extractTurnFromStart = (value: unknown): { id?: string } => {
  const record = asRecord(value);
  const turn = asRecord(record.turn);
  return { id: asString(turn.id) || asString(record.id) };
};

const extractActiveTurnId = (value: unknown): string | undefined => {
  const thread = asRecord(asRecord(value).thread);
  if (!Array.isArray(thread.turns)) {
    return undefined;
  }
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = asRecord(thread.turns[index]);
    if (asString(turn.status) === "inProgress") {
      return asString(turn.id);
    }
  }
  return undefined;
};

const buildInput = (prompt: string): Record<string, unknown>[] => [
  {
    type: "text",
    text: prompt,
    [USER_INPUT_TEXT_ELEMENTS]: [],
  },
];

const toError = (value: Error | unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const sendWsFrame = (
  ws: import("./ws-client").WsClient,
  payload: Record<string, unknown>
): void => {
  ws.send(`${JSON.stringify(payload)}\n`);
};

const sendWsResponse = (
  ws: import("./ws-client").WsClient,
  requestId: string,
  result: unknown,
  error: unknown
): void => {
  sendWsFrame(
    ws,
    error === undefined
      ? { id: requestId, jsonrpc: "2.0", result }
      : { id: requestId, error, jsonrpc: "2.0" }
  );
};

const sendWsNotification = (
  ws: import("./ws-client").WsClient,
  method: string,
  params?: Record<string, unknown>
): void => {
  sendWsFrame(ws, {
    ...(params ? { params } : {}),
    jsonrpc: "2.0",
    method,
  });
};

const handleWsServerRequest = (
  ws: import("./ws-client").WsClient,
  requestId: string,
  method: string
): void => {
  if (
    method === METHOD_COMMAND_APPROVAL ||
    method === METHOD_FILE_CHANGE_APPROVAL
  ) {
    sendWsResponse(ws, requestId, { decision: "accept" }, undefined);
    return;
  }
  if (method === METHOD_TOOL_USER_INPUT) {
    sendWsResponse(ws, requestId, { answers: {} }, undefined);
    return;
  }
  if (
    method === METHOD_TOOL_CALL ||
    method === METHOD_APPLY_PATCH_APPROVAL ||
    method === METHOD_EXEC_COMMAND_APPROVAL ||
    method === METHOD_AUTH_REFRESH
  ) {
    sendWsResponse(ws, requestId, undefined, {
      code: -32_601,
      message: "request unsupported by loop bridge",
    });
    return;
  }
  sendWsResponse(ws, requestId, undefined, {
    code: -32_601,
    message: `unsupported request method ${method}`,
  });
};

const extractNotificationTurnId = (
  params: Record<string, unknown>
): string | undefined => extractTurnId(params);

const settlePendingTurn = (
  pendingTurns: Map<string, PendingTurnCompletion>,
  turnId: string,
  error?: Error
): void => {
  const turn = pendingTurns.get(turnId);
  if (!turn) {
    return;
  }
  clearTimeout(turn.timeout);
  pendingTurns.delete(turnId);
  if (error) {
    turn.reject(error);
    return;
  }
  turn.resolve();
};

const turnNotificationError = (
  method: string,
  turnId: string,
  params: Record<string, unknown>
): Error | undefined => {
  if (method === METHOD_ERROR) {
    return new Error(parseErrorText(params) || `turn ${turnId} failed`);
  }
  if (method !== METHOD_TURN_COMPLETED) {
    return undefined;
  }
  const turn = asRecord(params.turn);
  const status = asString(params.status) ?? asString(turn.status);
  if (status !== "failed") {
    return undefined;
  }
  return new Error(
    parseErrorText(params) || parseErrorText(turn) || `turn ${turnId} failed`
  );
};

const handleRemoteTurnNotification = (
  pendingTurns: Map<string, PendingTurnCompletion>,
  method: string,
  params: Record<string, unknown>
): void => {
  const turnId = extractNotificationTurnId(params);
  if (!turnId) {
    return;
  }
  if (method !== METHOD_ERROR && method !== METHOD_TURN_COMPLETED) {
    return;
  }
  settlePendingTurn(
    pendingTurns,
    turnId,
    turnNotificationError(method, turnId, params)
  );
};

const handleRemoteClientResponse = (
  pending: Map<string, PendingRequest>,
  requestId: string,
  frame: JsonFrame
): void => {
  const request = pending.get(requestId);
  if (!request) {
    return;
  }
  clearTimeout(request.timeout);
  pending.delete(requestId);
  if (frame.error !== undefined) {
    request.reject(
      new Error(
        parseErrorText(frame.error) ||
          `codex app-server request "${request.method}" failed`
      )
    );
    return;
  }
  request.resolve(frame.result);
};

const handleRemoteClientFrame = (
  ws: import("./ws-client").WsClient,
  pending: Map<string, PendingRequest>,
  pendingTurns: Map<string, PendingTurnCompletion>,
  frame: JsonFrame
): void => {
  const frameId = asRequestId(frame.id);
  const method = asString(frame.method);
  if (frameId && method) {
    handleWsServerRequest(ws, frameId, method);
    return;
  }
  if (frameId) {
    handleRemoteClientResponse(pending, frameId, frame);
    return;
  }
  if (method) {
    handleRemoteTurnNotification(pendingTurns, method, asRecord(frame.params));
  }
};

const createRemoteAppServerClient = async (
  url: string
): Promise<{
  close(): void;
  sendNotification(method: string, params?: Record<string, unknown>): void;
  sendRequest(method: string, params: unknown): Promise<unknown>;
  waitForTurnCompletion(turnId: string): Promise<void>;
}> => {
  const ws = await connectWsFn(url);
  let closed = false;
  let requestId = 1;
  const pending = new Map<string, PendingRequest>();
  const pendingTurns = new Map<string, PendingTurnCompletion>();

  const failAll = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    for (const turn of pendingTurns.values()) {
      clearTimeout(turn.timeout);
      turn.reject(error);
    }
    pendingTurns.clear();
  };

  ws.onmessage = (data) => {
    for (const line of data.split("\n")) {
      const frame = parseLine(line);
      if (!frame) {
        continue;
      }
      handleRemoteClientFrame(ws, pending, pendingTurns, frame);
    }
  };

  ws.onclose = () => {
    if (closed) {
      return;
    }
    closed = true;
    failAll(new Error("codex app-server remote connection closed"));
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      ws.close();
      failAll(new Error("codex app-server remote connection closed"));
    },
    sendNotification: (method, params) => {
      if (closed) {
        throw new Error("codex app-server remote connection closed");
      }
      sendWsNotification(ws, method, params);
    },
    sendRequest: (method: string, params: unknown): Promise<unknown> => {
      if (closed) {
        return Promise.reject(
          new Error("codex app-server remote connection closed")
        );
      }
      const nextRequestId = String(requestId++);
      try {
        sendWsFrame(ws, { id: nextRequestId, method, params });
      } catch (error) {
        return Promise.reject(
          new Error(
            `codex app-server request "${method}" failed to write: ${
              toError(error).message
            }`
          )
        );
      }

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(nextRequestId);
          reject(new Error(`codex app-server request "${method}" timed out`));
        }, AGENT_TURN_TIMEOUT_MS);
        pending.set(nextRequestId, { method, reject, resolve, timeout });
      });
    },
    waitForTurnCompletion: (turnId: string): Promise<void> => {
      if (closed) {
        return Promise.reject(
          new Error("codex app-server remote connection closed")
        );
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingTurns.delete(turnId);
          reject(new Error(`codex app-server turn ${turnId} timed out`));
        }, AGENT_TURN_TIMEOUT_MS);
        pendingTurns.set(turnId, { reject, resolve, timeout });
      });
    },
  };
};

export class CodexAppServerFallbackError extends Error {}
export class CodexAppServerUnexpectedExitError extends CodexAppServerFallbackError {}

export const codexAppServerInternals = {
  parseLine,
  parseText,
  extractTurnId,
  extractThreadId,
  normalizeConfigValues,
  parseErrorText,
  setSpawnFn: (next: SpawnFn): void => {
    spawnFn = next;
  },
  restoreSpawnFn: (): void => {
    spawnFn = spawn;
  },
  setConnectWsFn: (next: ConnectWsFn): void => {
    connectWsFn = next;
  },
  restoreConnectWsFn: (): void => {
    connectWsFn = defaultConnectWs;
  },
  setListenerOwnerPidFn: (next: ListenerOwnerPidFn): void => {
    listenerOwnerPidFn = next;
  },
  restoreListenerOwnerPidFn: (): void => {
    listenerOwnerPidFn = defaultListenerOwnerPid;
  },
  cleanupOnProcessExit: (): void => {
    cleanupAppServerOnProcessExit();
  },
};

class AppServerClient {
  private child: ReturnType<typeof spawn> | undefined;
  private configValues: string[] = [];
  private connectUrl = "";
  private ws: import("./ws-client").WsClient | undefined;
  private closed = false;
  private env: NodeJS.ProcessEnv | undefined;
  private lastThreadId = "";
  private orphanOnExit = false;
  private persistentThread = false;
  private threadModel = "";
  private started = false;
  private ready = false;
  private requestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly turns = new Map<string, TurnState>();
  private lock: Promise<void> = Promise.resolve();
  private launchGeneration = 0;
  private launchAbortController: AbortController | undefined;
  private startPromise: Promise<void> | undefined;

  get process(): ReturnType<typeof spawn> | undefined {
    return this.ready ? this.child : undefined;
  }

  get processForExit(): ReturnType<typeof spawn> | undefined {
    return this.child;
  }

  getLastThreadId(): string {
    return this.lastThreadId;
  }

  getConnectUrl(): string {
    return this.ready ? this.connectUrl : "";
  }

  hasProcess(): boolean {
    return this.ready && this.child !== undefined;
  }

  needsRestart(options: AppServerLaunchOptions = {}): boolean {
    if (!this.started) {
      return false;
    }
    return (
      !sameConfigValues(
        this.configValues,
        normalizeConfigValues(options.configValues)
      ) ||
      this.orphanOnExit !== (options.orphanOnExit ?? false) ||
      this.env?.CODEX_HOME !== options.env?.CODEX_HOME
    );
  }

  configureLaunch(options: AppServerLaunchOptions = {}): void {
    this.configValues = normalizeConfigValues(options.configValues);
    this.env = options.env;
    this.orphanOnExit = options.orphanOnExit ?? false;
    this.persistentThread = options.persistentThread ?? false;
    if (options.resumeThreadId !== undefined) {
      this.lastThreadId = options.resumeThreadId;
    }
    this.threadModel = options.threadModel ?? "";
  }

  private async ensurePersistentLaunchThread(): Promise<void> {
    if (
      !(
        this.ready &&
        this.persistentThread &&
        !this.lastThreadId &&
        this.threadModel
      )
    ) {
      return;
    }
    await this.ensureThread(this.threadModel);
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      await this.ensurePersistentLaunchThread();
      return;
    }
    if (this.started) {
      await this.ensurePersistentLaunchThread();
      return;
    }
    const startPromise = this.startExclusive();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  private async startExclusive(): Promise<void> {
    this.started = true;
    const generation = ++this.launchGeneration;
    const abortController = new AbortController();
    this.launchAbortController = abortController;
    let ownedChild: ReturnType<typeof spawn> | undefined;
    let ownedWs: import("./ws-client").WsClient | undefined;
    try {
      const port = await this.findPort();
      const listenUrl = `ws://127.0.0.1:${port}`;
      const connectUrl = `ws://127.0.0.1:${port}`;
      this.connectUrl = connectUrl;
      const configArgs = this.configValues.flatMap((value) => ["-c", value]);
      const child = spawnFn(
        [APP_SERVER_CMD, ...configArgs, "app-server", "--listen", listenUrl],
        {
          detached: DETACH_CHILD_PROCESS,
          env: this.env ?? process.env,
          stderr: this.orphanOnExit ? "ignore" : "pipe",
          stdin: this.orphanOnExit ? "ignore" : "pipe",
          stdout: this.orphanOnExit ? "ignore" : "pipe",
        }
      );
      ownedChild = child;
      this.child = child;
      if (this.orphanOnExit) {
        child.unref?.();
        child.exited.then(() => {
          this.handleUnexpectedExit(generation, child);
        });
      } else {
        this.consumeFrames(child).finally(() => {
          this.handleUnexpectedExit(generation, child);
        });
      }
      await this.waitForOwnedListener(port, generation, child);
      const ownsListener = (): boolean =>
        this.launchOwnsListener(port, generation, child);
      const ws = await this.connectWebSocket(
        connectUrl,
        ownsListener,
        abortController.signal
      );
      ownedWs = ws;
      if (!ownsListener()) {
        throw new CodexAppServerFallbackError(
          "codex app-server listener is not owned by the spawned process"
        );
      }
      if (!this.launchOwnsConnection(generation, child, ws)) {
        throw new CodexAppServerFallbackError(
          "codex app-server connection was not accepted by the spawned process"
        );
      }
      this.ws = ws;
      ws.onmessage = (data) => {
        if (
          generation !== this.launchGeneration ||
          this.child !== child ||
          this.ws !== ws
        ) {
          return;
        }
        for (const line of data.split("\n")) {
          if (line.trim()) {
            this.handleStdoutLine(line);
          }
        }
      };
      ws.onclose = () => {
        this.handleUnexpectedExit(generation, child, ws);
      };
      await this.sendRequest(METHOD_INITIALIZE, {
        clientInfo: {
          name: "loop",
          title: "loop",
          version: LOOP_VERSION,
        },
        capabilities: { experimentalApi: true },
      });
      this.sendNotification(METHOD_INITIALIZED);
      this.ready = true;
      await this.ensurePersistentLaunchThread();
      if (this.launchAbortController === abortController) {
        this.launchAbortController = undefined;
      }
    } catch (error) {
      this.cleanupFailedLaunch(
        generation,
        ownedChild,
        ownedWs,
        abortController
      );
      throw new CodexAppServerFallbackError(
        toError(error).message || "failed to start codex app-server"
      );
    }
  }

  private cleanupFailedLaunch(
    generation: number,
    child: ReturnType<typeof spawn> | undefined,
    ws: import("./ws-client").WsClient | undefined,
    abortController: AbortController
  ): void {
    abortController.abort();
    if (this.launchAbortController === abortController) {
      this.launchAbortController = undefined;
    }
    if (this.launchGeneration === generation && this.ws === ws) {
      this.ws = undefined;
    }
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // ignore termination errors
      }
    }
    if (child) {
      killChildProcess(child, "SIGTERM");
    }
    if (this.launchGeneration !== generation || this.child !== child) {
      return;
    }
    this.child = undefined;
    this.connectUrl = "";
    this.ready = false;
    this.started = false;
  }

  private findPort(): Promise<number> {
    return findFreePort(APP_SERVER_BASE_PORT, APP_SERVER_PORT_RANGE);
  }

  private launchOwnsListener(
    port: number,
    generation: number,
    child: ReturnType<typeof spawn>
  ): boolean {
    return (
      generation === this.launchGeneration &&
      this.child === child &&
      listenerOwnerPidFn(port) === child.pid
    );
  }

  private launchOwnsConnection(
    generation: number,
    child: ReturnType<typeof spawn>,
    ws: import("./ws-client").WsClient
  ): boolean {
    return (
      generation === this.launchGeneration &&
      this.child === child &&
      ws.acceptedByPid(child.pid)
    );
  }

  private async waitForOwnedListener(
    port: number,
    generation: number,
    child: ReturnType<typeof spawn>
  ): Promise<void> {
    for (let attempt = 0; attempt < WS_CONNECT_ATTEMPTS; attempt += 1) {
      if (generation !== this.launchGeneration || this.child !== child) {
        break;
      }
      const ownerPid = listenerOwnerPidFn(port);
      if (ownerPid === child.pid) {
        return;
      }
      // An occupied port is not startup latency: another process owns it.
      if (ownerPid !== undefined) {
        break;
      }
      if (attempt < WS_CONNECT_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, WS_CONNECT_DELAY_MS)
        );
      }
    }
    throw new CodexAppServerFallbackError(
      "codex app-server listener is not owned by the spawned process"
    );
  }

  private async connectWebSocket(
    url: string,
    ownsListener: () => boolean,
    signal: AbortSignal
  ): Promise<import("./ws-client").WsClient> {
    for (let i = 0; i < WS_CONNECT_ATTEMPTS; i++) {
      if (signal.aborted) {
        throw new CodexAppServerFallbackError(
          "codex app-server WebSocket connection cancelled"
        );
      }
      if (!ownsListener()) {
        throw new CodexAppServerFallbackError(
          "codex app-server listener is not owned by the spawned process"
        );
      }
      try {
        return await connectWsFn(url, { signal });
      } catch {
        if (signal.aborted) {
          throw new CodexAppServerFallbackError(
            "codex app-server WebSocket connection cancelled"
          );
        }
        if (i === WS_CONNECT_ATTEMPTS - 1) {
          throw new CodexAppServerFallbackError(
            "failed to connect to codex app-server WebSocket"
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, WS_CONNECT_DELAY_MS)
        );
      }
    }
    throw new CodexAppServerFallbackError("unreachable");
  }

  runTurn(
    prompt: string,
    opts: Options,
    onParsed: Callback,
    onRaw: Callback,
    resumeThreadId?: string
  ): Promise<RunResult> {
    const task = this.lock.then(() =>
      this.runTurnExclusive(prompt, opts, onParsed, onRaw, resumeThreadId)
    );
    this.lock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  interrupt(signal: ExitSignal): void {
    killChildProcess(this.child, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("codex app-server closed"));
    const abortController = this.launchAbortController;
    if (this.launchAbortController === abortController) {
      this.launchAbortController = undefined;
    }
    abortController?.abort();
    const generation = this.launchGeneration;
    const invalidatedGeneration = generation + 1;
    this.launchGeneration = invalidatedGeneration;
    const child = this.child;
    const ws = this.ws;
    if (this.ws === ws) {
      this.ws = undefined;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    if (!child) {
      if (
        this.launchGeneration === invalidatedGeneration &&
        this.child === child
      ) {
        this.connectUrl = "";
        this.started = false;
        this.ready = false;
      }
      return;
    }
    killChildProcess(child, "SIGTERM");
    await child.exited;
    if (
      this.launchGeneration !== invalidatedGeneration ||
      this.child !== child
    ) {
      return;
    }
    this.child = undefined;
    this.connectUrl = "";
    this.ready = false;
    this.started = false;
  }

  release(): void {
    this.closed = true;
    this.failAll(new Error("codex app-server released"));
    const abortController = this.launchAbortController;
    if (this.launchAbortController === abortController) {
      this.launchAbortController = undefined;
    }
    abortController?.abort();
    const generation = this.launchGeneration;
    const invalidatedGeneration = generation + 1;
    this.launchGeneration = invalidatedGeneration;
    const child = this.child;
    const ws = this.ws;
    if (this.ws === ws) {
      this.ws = undefined;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    if (
      this.launchGeneration === invalidatedGeneration &&
      this.child === child
    ) {
      this.child = undefined;
      this.connectUrl = "";
      this.ready = false;
      this.started = false;
    }
  }

  private async ensureThread(
    model: string,
    resumeThreadId?: string
  ): Promise<string> {
    if (resumeThreadId) {
      this.lastThreadId = resumeThreadId;
      return resumeThreadId;
    }
    if (this.persistentThread && this.lastThreadId) {
      return this.lastThreadId;
    }
    const response = await this.sendRequest(METHOD_THREAD_START, {
      model,
      approvalPolicy: "never",
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });
    const thread = extractThreadFromTurnStart(response);
    if (!thread.id) {
      throw new CodexAppServerFallbackError(
        "codex app-server returned thread/start without thread id"
      );
    }
    this.lastThreadId = thread.id;
    return thread.id;
  }

  private async runTurnExclusive(
    prompt: string,
    opts: Options,
    onParsed: Callback,
    onRaw: Callback,
    resumeThreadId?: string
  ): Promise<RunResult> {
    if (!(this.child && this.ready)) {
      await this.start();
    }
    if (!this.child) {
      throw new CodexAppServerFallbackError("codex app-server not running");
    }

    const threadId = await this.ensureThread(opts.codexModel, resumeThreadId);
    const response = await this.sendRequest(METHOD_TURN_START, {
      threadId,
      input: buildInput(prompt),
      model: opts.codexModel,
      effort: DEFAULT_CODEX_REASONING_EFFORT,
      cwd: null,
    });
    const turn = extractTurnFromStart(response);
    if (!turn.id) {
      throw new CodexAppServerFallbackError(
        "codex app-server returned turn/start without turn id"
      );
    }

    const turnId = turn.id;
    return new Promise<RunResult>((resolve, reject) => {
      const state: TurnState = {
        activeItemAggregate: "",
        activeItemHasDelta: false,
        activeItemId: "",
        combined: "",
        completedItems: new Map(),
        onParsed,
        onRaw,
        parsed: "",
        pendingMessageBreak: false,
        reject,
        resolve,
        threadId,
        turnId,
      };
      this.turns.set(turnId, state);
      const timeout = setTimeout(() => {
        if (this.turns.delete(turnId)) {
          state.reject(new Error(`codex app-server turn ${turnId} timed out`));
        }
      }, AGENT_TURN_TIMEOUT_MS);
      const clear = () => clearTimeout(timeout);
      state.resolve = (result) => {
        clear();
        resolve(result);
      };
      state.reject = (error) => {
        clear();
        reject(error);
      };
    });
  }

  private async consumeFrames(proc: ReturnType<typeof spawn>): Promise<void> {
    const { stderr, stdout } = proc;
    if (typeof stdout === "number" || typeof stderr === "number") {
      throw new Error("codex app-server requires piped output streams");
    }
    await Promise.all([
      this.drainStream(stdout),
      this.consumeStream(stderr, this.handleStdErrLine),
    ]);
  }

  private async drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        // drain only — all JSON-RPC goes through WebSocket
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeStream(
    stream: ReadableStream<Uint8Array>,
    handler: (line: string) => void
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          handler(line);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) {
        handler(buffer.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }

  private readonly handleStdoutLine = (line: string): void => {
    const frame = parseLine(line);
    if (!frame) {
      return;
    }
    const method = asString(frame.method);
    if (method && frame.id === undefined) {
      const params = asRecord(frame.params);
      const state = this.selectTurnState(params);
      const rawLine = state
        ? this.completionAuthoritativeRawLine(state, method, params)
        : undefined;
      if (state && rawLine) {
        state.combined += `${rawLine}\n`;
        state.onRaw(rawLine);
      }
    }
    this.handleFrame(frame);
  };

  private completionAuthoritativeRawLine(
    state: TurnState,
    method: string,
    params: Record<string, unknown>
  ): string | undefined {
    if (method === METHOD_ITEM_DELTA) {
      const text = asString(params.delta);
      if (!text) {
        return undefined;
      }
      const itemId = normalizeItemId(params);
      if (itemId.conflict) {
        return undefined;
      }
      return JSON.stringify({
        method,
        params: {
          delta: text,
          ...(itemId.value ? { itemId: itemId.value } : {}),
        },
      });
    }
    if (method !== METHOD_ITEM_COMPLETED) {
      return undefined;
    }
    const item = asRecord(params.item);
    const itemType = asString(item.type);
    if (itemType !== "agentMessage" && itemType !== "agent_message") {
      return undefined;
    }
    const candidate = parseAgentMessageText(item);
    if (!candidate) {
      return undefined;
    }
    const itemId = normalizeItemId(params, item);
    if (itemId.conflict) {
      return undefined;
    }
    if (itemId.value && state.completedItems.get(itemId.value) === candidate) {
      return undefined;
    }
    const sameItem = isSameActiveItem(state, itemId.value);
    if (sameItem && candidate === state.activeItemAggregate.trim()) {
      return undefined;
    }
    return JSON.stringify({
      method,
      params: {
        item: {
          content: [{ text: candidate }],
          ...(itemId.value ? { id: itemId.value } : {}),
          type: "agentMessage",
        },
      },
    });
  }

  // Process stderr has no thread/turn identity. Keep it out of every turn's
  // renderer and decision input rather than attributing one process-level line
  // to whichever task happens to be active.
  private readonly handleStdErrLine = (_line: string): void => undefined;

  private selectTurnState(
    payload: Record<string, unknown>
  ): TurnState | undefined {
    const identity = normalizeIdentity(payload);
    if (identity.conflict) {
      return undefined;
    }
    const state = this.selectOuterTurnState(identity);
    return state && ownsNestedIdentity(payload, state) ? state : undefined;
  }

  private selectOuterTurnState({
    threadId,
    turnId,
  }: NormalizedIdentity): TurnState | undefined {
    if (turnId) {
      const state = this.turns.get(turnId);
      if (!state || (threadId && state.threadId !== threadId)) {
        return undefined;
      }
      return state;
    }
    if (threadId) {
      const matches = [...this.turns.values()].filter(
        (state) => state.threadId === threadId
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
    return undefined;
  }

  private handleFrame(frame: JsonFrame): void {
    const method = asString(frame.method);
    const requestId = asRequestId(frame.id);

    if (requestId && method) {
      this.handleServerRequest(requestId, method, asRecord(frame.params));
      return;
    }
    if (requestId) {
      this.handleResponse(requestId, frame.result, frame.error);
      return;
    }
    if (method) {
      this.handleNotification(method, asRecord(frame.params));
    }
  }

  private handleResponse(
    requestId: string,
    result: unknown,
    err: unknown
  ): void {
    const request = this.pending.get(requestId);
    if (!request) {
      return;
    }
    clearTimeout(request.timeout);
    this.pending.delete(requestId);
    if (err !== undefined) {
      const message =
        parseErrorText(err) ||
        parseErrorText({ error: err }) ||
        `codex app-server request "${request.method}" failed`;
      const shouldFallback =
        isUnsupportedTransportError(err) &&
        METHODS_TRIGGERING_FALLBACK.has(request.method);
      if (shouldFallback) {
        request.reject(new CodexAppServerFallbackError(message));
      } else {
        request.reject(new Error(message));
      }
      return;
    }
    request.resolve(result);
  }

  private handleServerRequest(
    requestId: string,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (!this.selectTurnState(params)) {
      this.sendResponse(requestId, undefined, {
        code: -32_601,
        message: "request is not attributed to an active loop turn",
      });
      return;
    }
    if (
      method === METHOD_COMMAND_APPROVAL ||
      method === METHOD_FILE_CHANGE_APPROVAL
    ) {
      this.sendResponse(requestId, { decision: "accept" }, undefined);
      return;
    }
    if (method === METHOD_TOOL_USER_INPUT) {
      this.sendResponse(requestId, { answers: {} }, undefined);
      return;
    }
    if (
      method === METHOD_TOOL_CALL ||
      method === METHOD_APPLY_PATCH_APPROVAL ||
      method === METHOD_EXEC_COMMAND_APPROVAL ||
      method === METHOD_AUTH_REFRESH
    ) {
      this.sendResponse(requestId, undefined, {
        code: -32_601,
        message: "request unsupported by loop runner",
      });
      return;
    }

    this.sendResponse(requestId, undefined, {
      code: -32_601,
      message: `unsupported request method ${method}`,
    });
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    const state = this.selectTurnState(params);
    switch (method) {
      case METHOD_ITEM_DELTA:
        this.handleItemDeltaNotification(state, params);
        return;
      case METHOD_ITEM_COMPLETED:
        this.handleItemCompletedNotification(state, params);
        return;
      case METHOD_ERROR:
        this.handleErrorNotification(state, params);
        return;
      case METHOD_TURN_COMPLETED:
        this.handleTurnCompletedNotification(state, params);
        return;
      default:
        return;
    }
  }

  private handleItemDeltaNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    const chunk = asString(params.delta);
    if (!chunk) {
      return;
    }
    const itemId = normalizeItemId(params);
    if (itemId.conflict) {
      return;
    }
    const itemChanged =
      Boolean(state.activeItemId) &&
      Boolean(itemId.value) &&
      state.activeItemId !== itemId.value;
    if (itemChanged) {
      state.activeItemAggregate = "";
      state.activeItemHasDelta = false;
    }
    if (
      (itemChanged || state.pendingMessageBreak) &&
      state.parsed &&
      !state.parsed.endsWith("\n") &&
      !chunk.startsWith("\n")
    ) {
      state.parsed += "\n";
    }
    state.pendingMessageBreak = false;
    if (itemId.value) {
      state.activeItemId = itemId.value;
    }
    state.activeItemHasDelta = true;
    state.activeItemAggregate += chunk;
    state.parsed += chunk;
    state.onParsed(chunk);
  }

  private handleItemCompletedNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    const item = asRecord(params.item);
    const itemType = asString(item.type);
    if (itemType !== "agentMessage" && itemType !== "agent_message") {
      return;
    }
    const candidate = parseAgentMessageText(item);
    if (!candidate) {
      return;
    }
    const itemId = normalizeItemId(params, item);
    if (itemId.conflict) {
      return;
    }
    if (itemId.value && state.completedItems.get(itemId.value) === candidate) {
      return;
    }
    const projection = completedItemProjection(state, itemId.value, candidate);
    if (projection.suffix) {
      const insertBoundary =
        projection.needsBoundary &&
        Boolean(state.parsed) &&
        !state.parsed.endsWith("\n") &&
        !projection.suffix.startsWith("\n");
      state.parsed += `${insertBoundary ? "\n" : ""}${projection.suffix}`;
      state.onParsed(projection.suffix);
    }
    if (itemId.value) {
      state.completedItems.set(itemId.value, candidate);
    }
    state.activeItemAggregate = "";
    state.activeItemHasDelta = false;
    state.activeItemId = "";
    state.pendingMessageBreak = true;
  }

  private handleErrorNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    for (const [turnId, current] of this.turns.entries()) {
      if (current === state) {
        this.turns.delete(turnId);
        break;
      }
    }
    state.reject(new Error(parseErrorText(params) || "codex turn failed"));
  }

  private handleTurnCompletedNotification(
    state: TurnState | undefined,
    params: Record<string, unknown>
  ): void {
    if (!state) {
      return;
    }
    this.resolveTurnState(state, params);
  }

  private resolveTurnState(
    state: TurnState,
    params: Record<string, unknown>
  ): void {
    const turn = asRecord(params.turn);
    const status = asString(params.status) ?? asString(turn.status);
    const exitCode = status === "failed" ? 1 : 0;
    const turnId = extractTurnId(params);

    if (turnId && this.turns.has(turnId)) {
      this.turns.delete(turnId);
    } else {
      for (const [key, value] of this.turns.entries()) {
        if (value === state) {
          this.turns.delete(key);
          break;
        }
      }
    }

    if (exitCode === 1) {
      const message =
        parseErrorText(params) || parseErrorText(turn) || "codex turn failed";
      const nextParsed = message
        ? `${state.parsed ? `${state.parsed}\n` : ""}${message}`
        : state.parsed;
      state.resolve({
        combined: state.combined,
        exitCode,
        parsed: nextParsed,
      });
      return;
    }

    state.resolve({
      combined: state.combined,
      exitCode: 0,
      parsed: state.parsed,
    });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!(this.ws || this.child) || this.closed) {
      return Promise.reject(
        new CodexAppServerFallbackError("codex app-server not initialized")
      );
    }
    const requestId = String(this.requestId++);
    const payload: Record<string, unknown> = {
      id: requestId,
      method,
      params,
    };
    try {
      this.sendFrame(payload);
    } catch (error) {
      throw new CodexAppServerFallbackError(
        `codex app-server request "${method}" failed to write: ${
          toError(error).message
        }`
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`codex app-server request "${method}" timed out`));
      }, AGENT_TURN_TIMEOUT_MS);
      this.pending.set(requestId, { method, resolve, reject, timeout });
    });
  }

  private sendFrame(payload: Record<string, unknown>): void {
    const data = `${JSON.stringify(payload)}\n`;
    if (this.ws) {
      this.ws.send(data);
    } else if (this.child) {
      const { stdin } = this.child;
      if (typeof stdin === "number") {
        throw new Error("codex app-server requires a piped input stream");
      }
      stdin.write(data);
    }
  }

  private sendResponse(
    requestId: string,
    result: unknown,
    error: unknown
  ): void {
    if (!(this.ws || this.child)) {
      return;
    }
    const payload =
      error === undefined
        ? { id: requestId, result, jsonrpc: "2.0" }
        : { id: requestId, error, jsonrpc: "2.0" };
    this.sendFrame(payload);
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): void {
    this.sendFrame({
      ...(params ? { params } : {}),
      jsonrpc: "2.0",
      method,
    });
  }

  private failAll(error: Error): void {
    for (const state of this.turns.values()) {
      state.reject(error);
    }
    this.turns.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private handleUnexpectedExit(
    generation: number,
    child: ReturnType<typeof spawn>,
    sourceWs?: import("./ws-client").WsClient
  ): void {
    if (
      this.closed ||
      generation !== this.launchGeneration ||
      this.child !== child ||
      (sourceWs !== undefined && this.ws !== sourceWs)
    ) {
      return;
    }
    const abortController = this.launchAbortController;
    this.launchAbortController = undefined;
    abortController?.abort();
    this.child = undefined;
    this.connectUrl = "";
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    killChildProcess(child, "SIGTERM");
    this.started = false;
    this.ready = false;
    this.failAll(
      new CodexAppServerUnexpectedExitError(
        "codex app-server exited unexpectedly"
      )
    );
  }
}

let singleton: AppServerClient | undefined;
let startAppServerLock: Promise<void> = Promise.resolve();

function cleanupAppServerOnProcessExit(): void {
  killChildProcess(singleton?.processForExit, "SIGKILL");
}

process.on("exit", cleanupAppServerOnProcessExit);

const getClient = (): AppServerClient => {
  if (!singleton) {
    singleton = new AppServerClient();
  }
  return singleton;
};

export const useAppServer = (): boolean =>
  process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC;

const startAppServerExclusive = async (
  options: AppServerLaunchOptions = {}
): Promise<void> => {
  const existing = singleton;
  const shouldRestart = existing?.needsRestart(options) ?? false;
  const resumeThreadId =
    options.resumeThreadId ??
    (options.persistentThread ? existing?.getLastThreadId() : undefined);
  if (shouldRestart) {
    await closeAppServer();
  }
  const client = getClient();
  client.configureLaunch(
    resumeThreadId === undefined ? options : { ...options, resumeThreadId }
  );
  await client.start();
};

export const startAppServer = (
  options: AppServerLaunchOptions = {}
): Promise<void> => {
  const task = startAppServerLock.then(() => startAppServerExclusive(options));
  startAppServerLock = task.then(
    () => undefined,
    () => undefined
  );
  return task;
};

export const runCodexTurn = (
  prompt: string,
  opts: Options,
  // Some callers render directly from raw events and intentionally skip parsed callbacks.
  callbacks: RunCodexTurnCallbacks,
  resumeThreadId?: string
): Promise<RunResult> => {
  return getClient().runTurn(
    prompt,
    opts,
    callbacks.onParsed ?? NOOP_CALLBACK,
    callbacks.onRaw,
    resumeThreadId
  );
};

export const interruptAppServer = (signal: ExitSignal): void => {
  getClient().interrupt(signal);
};

export const hasAppServerProcess = (): boolean => getClient().hasProcess();

export const getCodexAppServerUrl = (): string =>
  singleton?.getConnectUrl() ?? "";

export const getCodexAppServerPid = (): number | undefined => {
  const pid = singleton?.process?.pid;
  return typeof pid === "number" && pid > 0 ? pid : undefined;
};

export const getLastCodexThreadId = (): string =>
  singleton?.getLastThreadId() ?? "";

const readOrResumeCodexThread = async (
  client: Awaited<ReturnType<typeof createRemoteAppServerClient>>,
  threadId: string
): Promise<unknown> => {
  try {
    return await client.sendRequest(METHOD_THREAD_READ, {
      includeTurns: true,
      threadId,
    });
  } catch {
    try {
      return await client.sendRequest(METHOD_THREAD_RESUME, {
        excludeTurns: false,
        threadId,
      });
    } catch (error) {
      if (!toError(error).message.includes("list_turns is not supported")) {
        throw error;
      }
      // Older app-server builds can resume the persisted thread but cannot
      // enumerate its turns. Delivery does not need historical turns: resume
      // the exact thread without them, then let turn/start provide the
      // authoritative busy-or-accepted result.
      return client.sendRequest(METHOD_THREAD_RESUME, {
        excludeTurns: true,
        threadId,
      });
    }
  }
};

const initializeBridgeClient = async (
  client: Awaited<ReturnType<typeof createRemoteAppServerClient>>
): Promise<void> => {
  await client.sendRequest(METHOD_INITIALIZE, {
    clientInfo: {
      name: "loop-bridge",
      title: "loop-bridge",
      version: LOOP_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [...BRIDGE_OPT_OUT_NOTIFICATION_METHODS],
    },
  });
  client.sendNotification(METHOD_INITIALIZED);
};

/**
 * Verifies that the exact configured thread can be read or resumed without
 * creating, steering, or submitting a turn. This is a provider liveness
 * probe, not recipient acknowledgement and not a thread discovery API.
 */
export const probeCodexThread = async (
  remoteUrl: string,
  threadId: string
): Promise<boolean> => {
  if (!(remoteUrl && threadId)) {
    return false;
  }
  let client:
    | Awaited<ReturnType<typeof createRemoteAppServerClient>>
    | undefined;
  try {
    client = await createRemoteAppServerClient(remoteUrl);
    await initializeBridgeClient(client);
    // Liveness must not depend on persisted historical turns. A newly
    // allocated live thread may not have a rollout until its first turn.
    // Only that condition, or an evicted (not loaded) thread, may fall back
    // to resume: auth, transport and other read failures are not-ready, so
    // a liveness probe never revives a thread it could not otherwise read.
    try {
      await client.sendRequest(METHOD_THREAD_READ, {
        includeTurns: false,
        threadId,
      });
    } catch (error) {
      if (!isThreadNotLoadedError(error)) {
        throw error;
      }
      await client.sendRequest(METHOD_THREAD_RESUME, {
        excludeTurns: true,
        threadId,
      });
    }
    return true;
  } catch {
    return false;
  } finally {
    client?.close();
  }
};

export const injectCodexMessage = async (
  remoteUrl: string,
  threadId: string,
  prompt: string
): Promise<boolean> => {
  if (!(remoteUrl && threadId && prompt.trim())) {
    return false;
  }
  const client = await createRemoteAppServerClient(remoteUrl);
  try {
    await initializeBridgeClient(client);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let activeTurnId: string | undefined;
      try {
        const thread = await readOrResumeCodexThread(client, threadId);
        activeTurnId = extractActiveTurnId(thread);
      } catch (error) {
        throw new Error(
          `codex bridge could not read or resume thread ${threadId}: ${toError(error).message}`
        );
      }

      if (activeTurnId) {
        try {
          await client.sendRequest(METHOD_TURN_STEER, {
            expectedTurnId: activeTurnId,
            input: buildInput(prompt),
            threadId,
          });
          return true;
        } catch {
          // The active turn may have already completed. Fall through to start.
        }
      }

      try {
        const response = await client.sendRequest(METHOD_TURN_START, {
          input: buildInput(prompt),
          threadId,
        });
        const turn = extractTurnFromStart(response);
        if (!turn.id) {
          throw new Error(
            "codex app-server returned turn/start without turn id"
          );
        }
        return true;
      } catch (error) {
        if (!(attempt === 0 && isBusyTurnError(error))) {
          throw error;
        }
      }
    }
    return false;
  } finally {
    client.close();
  }
};

export const closeAppServer = async (): Promise<void> => {
  const client = singleton;
  if (!client) {
    return;
  }
  singleton = undefined;
  await client.close();
};

export const releaseAppServer = (): void => {
  if (!singleton) {
    return;
  }
  singleton.release();
  singleton = undefined;
};

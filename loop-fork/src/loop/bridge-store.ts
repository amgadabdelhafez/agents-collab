import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS } from "./agents";
import { resolveClaudeChannelServerName } from "./bridge-config";
import { BRIDGE_SERVER } from "./bridge-constants";
import { normalizeBridgeMessage } from "./bridge-message-format";
import {
  appendRunTranscriptEntry,
  buildTranscriptPath,
  readRunManifest,
} from "./run-state";
import type { Agent } from "./types";

export type BridgeSource = Agent | "supervisor" | "utility";

const BRIDGE_FILE = "bridge.jsonl";
const LINE_SPLIT_RE = /\r?\n/;
export const BRIDGE_RECEIVE_LIMIT = 100;
export const DEFAULT_BRIDGE_MAX_OUTSTANDING = 32;

export type BridgeMessageType =
  | "message"
  | "work_request"
  | "review_request"
  | "decision"
  | "handover"
  | "escalation"
  | "ack";
export type BridgePriority = "low" | "normal" | "high" | "urgent";
export type BridgeResolution =
  | "blocked"
  | "delivered"
  | "expired"
  | "reported"
  | "superseded"
  | "dead-letter";

const MESSAGE_TYPES = new Set<BridgeMessageType>([
  "message",
  "work_request",
  "review_request",
  "decision",
  "handover",
  "escalation",
  "ack",
]);
const PRIORITIES = new Set<BridgePriority>(["low", "normal", "high", "urgent"]);
const PRIORITY_ORDER: Record<BridgePriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};
const RESOLUTIONS = new Set<BridgeResolution>([
  "blocked",
  "delivered",
  "expired",
  "reported",
  "superseded",
  "dead-letter",
]);

interface BridgeBaseEvent {
  at: string;
  id: string;
  signature?: string;
  source: BridgeSource;
  target: Agent;
}

export interface BridgeMessage extends BridgeBaseEvent {
  artifactRefs?: string[];
  dedupeKey?: string;
  expiresAt?: string;
  kind: "message";
  message: string;
  priority?: BridgePriority;
  replyTo?: string;
  subject?: string;
  taskId?: string;
  threadId?: string;
  type?: BridgeMessageType;
}

interface BridgeAck extends BridgeBaseEvent {
  kind: BridgeResolution;
  message?: string;
  reason?: string;
}

export type BridgeEvent = BridgeAck | BridgeMessage;

export interface BridgeEnqueueOptions {
  artifactRefs?: string[];
  dedupeKey?: string;
  expiresAt?: string;
  maxOutstanding?: number;
  now?: string;
  priority?: BridgePriority;
  replyTo?: string;
  subject?: string;
  supersede?: boolean;
  taskId?: string;
  threadId?: string;
  ttlMs?: number;
  type?: BridgeMessageType;
}

export interface BridgeEnqueueResult {
  entry: BridgeMessage;
  reason?: string;
  status: "queued" | "duplicate" | "dead-letter" | "expired";
}

export interface BridgeDeadLetter {
  entry: BridgeMessage;
  reason?: string;
}

export interface BridgeQueueHealth {
  deadLetters: number;
  expired: number;
  oldestPendingAt?: string;
  pending: number;
  superseded: number;
  unreportedDeadLetters: number;
}

export interface BridgeStatus {
  bridgeServer: string;
  claudeBridgeMode: "local-registration" | "mcp-config";
  claudeChannelServer: string;
  claudeSessionId: string;
  codexRemoteUrl: string;
  codexThreadId: string;
  hasCodexRemote: boolean;
  hasTmuxSession: boolean;
  pending: Record<Agent, number>;
  qos: BridgeQueueHealth;
  runId: string;
  state: string;
  status: string;
  tmuxSession: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry)
  );
  return strings.length > 0 ? strings : undefined;
};

const asMessageType = (value: unknown): BridgeMessageType | undefined =>
  typeof value === "string" && MESSAGE_TYPES.has(value as BridgeMessageType)
    ? (value as BridgeMessageType)
    : undefined;

const asPriority = (value: unknown): BridgePriority | undefined =>
  typeof value === "string" && PRIORITIES.has(value as BridgePriority)
    ? (value as BridgePriority)
    : undefined;

export const normalizeAgent = (value: unknown): Agent | undefined => {
  if (typeof value === "string" && AGENTS.includes(value as Agent)) {
    return value as Agent;
  }
  return undefined;
};

const normalizeBridgeSource = (value: unknown): BridgeSource | undefined =>
  value === "utility" || value === "supervisor" ? value : normalizeAgent(value);

const orderedBridgePairKey = (source: BridgeSource, target: Agent): string =>
  `${source}>${target}`;

const bridgeSignature = (
  source: BridgeSource,
  target: Agent,
  message: string
): string => {
  return createHash("sha256")
    .update(
      `${orderedBridgePairKey(source, target)}\n${normalizeBridgeMessage(message)}`,
      "utf8"
    )
    .digest("hex");
};

const eventSignature = (event: BridgeMessage): string =>
  bridgeSignature(event.source, event.target, event.message);

export const bridgePath = (runDir: string): string => join(runDir, BRIDGE_FILE);

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

export const appendBridgeEvent = (runDir: string, event: BridgeEvent): void => {
  const path = bridgePath(runDir);
  ensureParentDir(path);
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
};

const parseBridgeMessage = (
  parsed: Record<string, unknown>,
  base: BridgeBaseEvent,
  message: string
): BridgeMessage => {
  const artifactRefs = asStringArray(parsed.artifactRefs);
  const dedupeKey = asString(parsed.dedupeKey);
  const expiresAt = asString(parsed.expiresAt);
  const replyTo = asString(parsed.replyTo);
  const subject = asString(parsed.subject);
  const taskId = asString(parsed.taskId);
  const threadId = asString(parsed.threadId);
  return {
    ...(artifactRefs ? { artifactRefs } : {}),
    ...base,
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    kind: "message",
    message,
    priority: asPriority(parsed.priority) ?? "normal",
    ...(replyTo ? { replyTo } : {}),
    signature: bridgeSignature(base.source, base.target, message),
    ...(subject ? { subject } : {}),
    ...(taskId ? { taskId } : {}),
    ...(threadId ? { threadId } : {}),
    type: asMessageType(parsed.type) ?? "message",
  };
};

const parseBridgeEvent = (
  value: unknown,
  messageById: Map<string, string>
): BridgeEvent | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = asString(value.kind);
  const id = asString(value.id);
  const at = asString(value.at);
  const source = normalizeBridgeSource(value.source);
  const target = normalizeAgent(value.target);
  if (!(kind && id && at && source && target)) {
    return undefined;
  }
  const base = { at, id, source, target };
  if (kind === "message") {
    const message = asString(value.message);
    if (!message) {
      return undefined;
    }
    messageById.set(id, message);
    return parseBridgeMessage(value, base, message);
  }
  if (!RESOLUTIONS.has(kind as BridgeResolution)) {
    return undefined;
  }
  return {
    ...base,
    kind: kind as BridgeResolution,
    message: messageById.get(id),
    reason: asString(value.reason),
    signature: asString(value.signature),
  };
};

export const readBridgeEvents = (runDir: string): BridgeEvent[] => {
  const path = bridgePath(runDir);
  if (!existsSync(path)) {
    return [];
  }

  const events: BridgeEvent[] = [];
  const messageById = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split(LINE_SPLIT_RE)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = parseBridgeEvent(
        JSON.parse(trimmed) as unknown,
        messageById
      );
      if (event) {
        events.push(event);
      }
    } catch {
      // ignore malformed bridge lines
    }
  }
  return events;
};

const pendingFromEvents = (events: BridgeEvent[]): BridgeMessage[] => {
  const messages = new Map<string, BridgeMessage>();

  for (const event of events) {
    if (event.kind === "message") {
      messages.set(event.id, event);
      continue;
    }
    const pending = messages.get(event.id);
    if (!pending) {
      continue;
    }
    messages.delete(event.id);
  }

  return [...messages.values()];
};

const bridgeMessagePriority = (message: BridgeMessage): number =>
  PRIORITY_ORDER[message.priority ?? "normal"];

const sortBridgeMessages = (
  left: BridgeMessage,
  right: BridgeMessage
): number =>
  bridgeMessagePriority(right) - bridgeMessagePriority(left) ||
  left.at.localeCompare(right.at) ||
  left.id.localeCompare(right.id);

const appendBridgeResolution = (
  runDir: string,
  message: BridgeMessage,
  kind: BridgeResolution,
  reason: string | undefined,
  at: string
): void => {
  appendBridgeEvent(runDir, {
    at,
    id: message.id,
    kind,
    reason,
    signature: eventSignature(message),
    source: message.source,
    target: message.target,
  });
};

export const readPendingBridgeMessages = (
  runDir: string,
  nowMs = Date.now()
): BridgeMessage[] => {
  const pending = pendingFromEvents(readBridgeEvents(runDir));
  const active: BridgeMessage[] = [];
  const now = new Date(nowMs).toISOString();
  for (const message of pending) {
    const expiresAt = message.expiresAt
      ? Date.parse(message.expiresAt)
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      appendBridgeResolution(
        runDir,
        message,
        "expired",
        `expired at ${message.expiresAt}`,
        now
      );
      continue;
    }
    active.push(message);
  }
  return active.sort(sortBridgeMessages);
};

const unreportedDeadLettersFromEvents = (
  events: BridgeEvent[],
  target?: Agent
): BridgeDeadLetter[] => {
  const deadLetters = new Map<string, BridgeAck>();
  const messages = new Map<string, BridgeMessage>();
  const reported = new Set<string>();

  for (const event of events) {
    if (event.kind === "message") {
      messages.set(event.id, event);
      continue;
    }
    if (event.kind === "dead-letter") {
      deadLetters.set(event.id, event);
      reported.delete(event.id);
      continue;
    }
    if (event.kind === "reported" && deadLetters.has(event.id)) {
      reported.add(event.id);
    }
  }

  return [...deadLetters.entries()]
    .filter(([id]) => !reported.has(id))
    .flatMap(([id, resolution]) => {
      const entry = messages.get(id);
      if (!(entry && (!target || entry.target === target))) {
        return [];
      }
      return [{ entry, reason: resolution.reason }];
    })
    .sort((left, right) => sortBridgeMessages(left.entry, right.entry));
};

export const readUnreportedBridgeDeadLetters = (
  runDir: string,
  target: Agent,
  limit = BRIDGE_RECEIVE_LIMIT
): BridgeDeadLetter[] => {
  if (limit <= 0) {
    return [];
  }
  return unreportedDeadLettersFromEvents(
    readBridgeEvents(runDir),
    target
  ).slice(0, limit);
};

export const markBridgeMessage = (
  runDir: string,
  message: BridgeMessage,
  kind: BridgeResolution,
  reason?: string
): void => {
  appendBridgeResolution(
    runDir,
    message,
    kind,
    reason,
    new Date().toISOString()
  );
};

export const markBridgeDeadLetterReported = (
  runDir: string,
  deadLetter: BridgeDeadLetter,
  reason = "read via receive_messages"
): void => {
  appendBridgeResolution(
    runDir,
    deadLetter.entry,
    "reported",
    reason,
    new Date().toISOString()
  );
};

export const blocksBridgeBounce = (
  runDir: string,
  source: BridgeSource,
  target: Agent,
  message: string
): boolean => {
  const normalized = normalizeBridgeMessage(message);
  const events = readBridgeEvents(runDir);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "delivered") {
      continue;
    }
    if (!event.message) {
      return false;
    }
    return (
      normalizeBridgeMessage(event.message) === normalized &&
      event.source === target &&
      event.target === source
    );
  }
  return false;
};

const countPendingMessages = (runDir: string): BridgeStatus["pending"] => {
  const pending = {
    claude: 0,
    codex: 0,
    copilot: 0,
    cursor: 0,
    gemini: 0,
  } satisfies Record<Agent, number>;
  for (const message of readPendingBridgeMessages(runDir).slice(
    0,
    BRIDGE_RECEIVE_LIMIT
  )) {
    pending[message.target] += 1;
  }
  return pending;
};

export const readBridgeStatus = (runDir: string): BridgeStatus => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  const runId = manifest?.runId ?? "";
  const codexRemoteUrl = manifest?.codexRemoteUrl ?? "";
  const codexThreadId = manifest?.codexThreadId ?? "";
  const tmuxSession = manifest?.tmuxSession ?? "";
  const hasTmuxSession = Boolean(tmuxSession);
  return {
    bridgeServer: BRIDGE_SERVER,
    claudeBridgeMode: hasTmuxSession ? "local-registration" : "mcp-config",
    claudeChannelServer: runId
      ? resolveClaudeChannelServerName(
          runId,
          manifest?.repoId,
          manifest?.claudeChannelServer
        )
      : BRIDGE_SERVER,
    claudeSessionId: manifest?.claudeSessionId ?? "",
    codexRemoteUrl,
    codexThreadId,
    hasCodexRemote: Boolean(codexRemoteUrl && codexThreadId),
    hasTmuxSession,
    pending: countPendingMessages(runDir),
    qos: readBridgeQueueHealth(runDir),
    runId,
    state: manifest?.state ?? "unknown",
    status: manifest?.status ?? "unknown",
    tmuxSession,
  };
};

export const readBridgeInbox = (
  runDir: string,
  target: Agent
): BridgeMessage[] =>
  readPendingBridgeMessages(runDir)
    .filter((message) => message.target === target)
    .slice(0, BRIDGE_RECEIVE_LIMIT);

export const formatBridgeInbox = (
  messages: BridgeMessage[],
  deadLetters: BridgeDeadLetter[] = []
): string =>
  JSON.stringify(
    [
      ...messages.map((message) => ({ message })),
      ...deadLetters.map(({ entry, reason }) => ({
        deliveryStatus: "dead-letter" as const,
        failureReason: reason,
        message: entry,
      })),
    ].map(({ deliveryStatus, failureReason, message }) => ({
      artifactRefs: message.artifactRefs,
      at: message.at,
      deliveryStatus,
      expiresAt: message.expiresAt,
      failureReason,
      from: message.source,
      id: message.id,
      message: message.message,
      priority: message.priority ?? "normal",
      replyTo: message.replyTo,
      subject: message.subject,
      taskId: message.taskId,
      threadId: message.threadId,
      type: message.type ?? "message",
    })),
    null,
    2
  );

const bridgeExpiry = (
  options: BridgeEnqueueOptions,
  nowMs: number
): string | undefined => {
  if (options.expiresAt) {
    const parsed = Date.parse(options.expiresAt);
    if (!Number.isFinite(parsed)) {
      throw new Error("bridge expiresAt must be an ISO timestamp");
    }
    return new Date(parsed).toISOString();
  }
  if (options.ttlMs === undefined) {
    return undefined;
  }
  if (!(Number.isFinite(options.ttlMs) && options.ttlMs > 0)) {
    throw new Error("bridge ttlMs must be positive");
  }
  return new Date(nowMs + options.ttlMs).toISOString();
};

const createBridgeMessage = (
  source: BridgeSource,
  target: Agent,
  message: string,
  options: BridgeEnqueueOptions
): BridgeMessage => {
  const at = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(at);
  if (!Number.isFinite(nowMs)) {
    throw new Error("bridge now must be an ISO timestamp");
  }
  const expiresAt = bridgeExpiry(options, nowMs);
  return {
    ...(options.artifactRefs?.length
      ? { artifactRefs: [...options.artifactRefs] }
      : {}),
    at,
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    id: crypto.randomUUID(),
    kind: "message",
    message,
    priority: options.priority ?? "normal",
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    signature: bridgeSignature(source, target, message),
    source,
    ...(options.subject ? { subject: options.subject } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    target,
    ...(options.threadId ? { threadId: options.threadId } : {}),
    type: options.type ?? "message",
  };
};

export const enqueueBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: Agent,
  message: string,
  options: BridgeEnqueueOptions = {}
): BridgeEnqueueResult => {
  const entry = createBridgeMessage(source, target, message, options);
  const nowMs = Date.parse(entry.at);
  const pending = readPendingBridgeMessages(runDir, nowMs);
  const duplicate = options.dedupeKey
    ? pending.find(
        (candidate) =>
          candidate.source === source &&
          candidate.target === target &&
          candidate.dedupeKey === options.dedupeKey
      )
    : undefined;
  if (duplicate && !options.supersede) {
    return {
      entry: duplicate,
      reason: `pending dedupe key ${options.dedupeKey}`,
      status: "duplicate",
    };
  }
  if (duplicate) {
    appendBridgeResolution(
      runDir,
      duplicate,
      "superseded",
      `superseded by ${entry.id}`,
      entry.at
    );
  }
  appendBridgeEvent(runDir, entry);
  appendRunTranscriptEntry(buildTranscriptPath(runDir), {
    at: entry.at,
    from: source,
    message,
    to: target,
  });
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) {
    appendBridgeResolution(
      runDir,
      entry,
      "expired",
      `expired at ${entry.expiresAt}`,
      entry.at
    );
    return { entry, reason: "message already expired", status: "expired" };
  }
  const targetPending = pending.filter(
    (candidate) => candidate.target === target && candidate.id !== duplicate?.id
  );
  const maxOutstanding =
    options.maxOutstanding ?? DEFAULT_BRIDGE_MAX_OUTSTANDING;
  if (targetPending.length >= maxOutstanding) {
    const reason = `target queue limit ${maxOutstanding} reached`;
    appendBridgeResolution(runDir, entry, "dead-letter", reason, entry.at);
    return { entry, reason, status: "dead-letter" };
  }
  return { entry, status: "queued" };
};

export const appendBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: Agent,
  message: string,
  options: BridgeEnqueueOptions = {}
): BridgeMessage =>
  enqueueBridgeMessage(runDir, source, target, message, options).entry;

export const readBridgeQueueHealth = (
  runDir: string,
  nowMs = Date.now()
): BridgeQueueHealth => {
  const pending = readPendingBridgeMessages(runDir, nowMs);
  const events = readBridgeEvents(runDir);
  return {
    deadLetters: events.filter((event) => event.kind === "dead-letter").length,
    expired: events.filter((event) => event.kind === "expired").length,
    oldestPendingAt: pending
      .map((message) => message.at)
      .sort((left, right) => left.localeCompare(right))[0],
    pending: pending.length,
    superseded: events.filter((event) => event.kind === "superseded").length,
    unreportedDeadLetters: unreportedDeadLettersFromEvents(events).length,
  };
};

export const appendBlockedBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: Agent,
  message: string,
  reason: string
): void => {
  appendBridgeEvent(runDir, {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    kind: "blocked",
    reason,
    signature: bridgeSignature(source, target, message),
    source,
    target,
  });
};

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
  type RunManifest,
  readRunManifest,
} from "./run-state";
import { type TmuxLiveness, tmuxPaneLiveness } from "./tmux-control";
import type { Agent } from "./types";

export type BridgeSource = Agent | "supervisor" | "utility";
export type BridgeTarget = Agent | "supervisor";

const BRIDGE_FILE = "bridge.jsonl";
const LINE_SPLIT_RE = /\r?\n/;
const MAX_STATUS_MESSAGES = 100;
export const DEFAULT_BRIDGE_MAX_OUTSTANDING = 32;
export const DEFAULT_BRIDGE_MAX_RETAINED = DEFAULT_BRIDGE_MAX_OUTSTANDING + 1;

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
  | "superseded"
  | "dead-letter";
export type BridgeNotificationKind = "notified";
export type BridgeTargetLiveness = TmuxLiveness;
export type BridgeTargetLivenessResolver = (
  target: BridgeTarget
) => BridgeTargetLiveness;

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
  "superseded",
  "dead-letter",
]);

interface BridgeBaseEvent {
  at: string;
  id: string;
  signature?: string;
  source: BridgeSource;
  target: BridgeTarget;
}

export interface BridgeMessage extends BridgeBaseEvent {
  artifactRefs?: string[];
  dedupeKey?: string;
  expiresAt?: string;
  kind: "message";
  message: string;
  priority?: BridgePriority;
  replyTo?: string;
  retainedReason?: "queue-pressure";
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

export interface BridgeNotification extends BridgeBaseEvent {
  kind: BridgeNotificationKind;
  reason?: string;
}

export type BridgeEvent = BridgeAck | BridgeMessage | BridgeNotification;

export interface BridgeEnqueueOptions {
  artifactRefs?: string[];
  dedupeKey?: string;
  expiresAt?: string;
  maxOutstanding?: number;
  maxRetained?: number;
  now?: string;
  priority?: BridgePriority;
  replyTo?: string;
  subject?: string;
  supersede?: boolean;
  targetLiveness?: BridgeTargetLivenessResolver;
  taskId?: string;
  threadId?: string;
  ttlMs?: number;
  type?: BridgeMessageType;
}

export interface BridgeEnqueueResult {
  entry: BridgeMessage;
  reason?: string;
  status: "queued" | "duplicate" | "dead-letter" | "expired" | "backpressure";
}

export interface BridgeQueueHealth {
  deadLetters: number;
  expired: number;
  oldestPendingAt?: string;
  pending: number;
  superseded: number;
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
  pending: Record<BridgeTarget, number>;
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

const asRetainedReason = (value: unknown): "queue-pressure" | undefined =>
  value === "queue-pressure" ? "queue-pressure" : undefined;

export const normalizeAgent = (value: unknown): Agent | undefined => {
  if (typeof value === "string" && AGENTS.includes(value as Agent)) {
    return value as Agent;
  }
  return undefined;
};

export const normalizeBridgeTarget = (
  value: unknown
): BridgeTarget | undefined =>
  value === "supervisor" ? value : normalizeAgent(value);

const normalizeBridgeSource = (value: unknown): BridgeSource | undefined =>
  value === "utility" || value === "supervisor" ? value : normalizeAgent(value);

const orderedBridgePairKey = (
  source: BridgeSource,
  target: BridgeTarget
): string => `${source}>${target}`;

const bridgeSignature = (
  source: BridgeSource,
  target: BridgeTarget,
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

const sameBridgeAckIdentity = (
  left: BridgeMessage,
  right: BridgeMessage
): boolean =>
  left.type === "ack" &&
  right.type === "ack" &&
  eventSignature(left) === eventSignature(right) &&
  left.subject === right.subject &&
  left.replyTo === right.replyTo &&
  left.taskId === right.taskId &&
  left.threadId === right.threadId &&
  (left.artifactRefs?.length ?? 0) === (right.artifactRefs?.length ?? 0) &&
  (left.artifactRefs?.every(
    (artifactRef, index) => artifactRef === right.artifactRefs?.[index]
  ) ??
    true);

const findCanonicalBridgeAck = (
  runDir: string,
  entry: BridgeMessage
): BridgeMessage | undefined =>
  entry.type === "ack"
    ? readBridgeEvents(runDir).find(
        (event): event is BridgeMessage =>
          event.kind === "message" && sameBridgeAckIdentity(event, entry)
      )
    : undefined;

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
  const retainedReason = asRetainedReason(parsed.retainedReason);
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
    ...(retainedReason ? { retainedReason } : {}),
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
  const target = normalizeBridgeTarget(value.target);
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
  if (kind === "notified") {
    return {
      ...base,
      kind,
      reason: asString(value.reason),
      signature: asString(value.signature),
    };
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
    if (event.kind === "notified") {
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

const supersedeBridgePredecessorForCanonicalAck = (
  runDir: string,
  pending: BridgeMessage | undefined,
  canonicalAck: BridgeMessage,
  entry: BridgeMessage,
  supersede: boolean | undefined
): void => {
  if (!(pending && supersede) || sameBridgeAckIdentity(pending, entry)) {
    return;
  }
  appendBridgeResolution(
    runDir,
    pending,
    "superseded",
    `superseded by ${canonicalAck.id}`,
    entry.at
  );
};

export interface BridgeTargetLivenessDeps {
  paneLiveness: (session: string, pane: string) => BridgeTargetLiveness;
  processLiveness: (pid: number) => BridgeTargetLiveness;
  readManifest: (path: string) => RunManifest | undefined;
}

const bridgeProcessLiveness = (pid: number): BridgeTargetLiveness => {
  if (!(Number.isInteger(pid) && pid > 0)) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
};

const DEFAULT_BRIDGE_TARGET_LIVENESS_DEPS: BridgeTargetLivenessDeps = {
  paneLiveness: tmuxPaneLiveness,
  processLiveness: bridgeProcessLiveness,
  readManifest: readRunManifest,
};

const combineTargetLiveness = (
  evidence: BridgeTargetLiveness[]
): BridgeTargetLiveness => {
  if (evidence.includes("live")) {
    return "live";
  }
  return evidence.length > 0 && evidence.every((state) => state === "dead")
    ? "dead"
    : "unknown";
};

export const readBridgeTargetLiveness = (
  runDir: string,
  target: BridgeTarget,
  overrides: Partial<BridgeTargetLivenessDeps> = {}
): BridgeTargetLiveness => {
  if (target === "supervisor") {
    return "unknown";
  }
  const deps = { ...DEFAULT_BRIDGE_TARGET_LIVENESS_DEPS, ...overrides };
  const manifest = deps.readManifest(join(runDir, "manifest.json"));
  if (!manifest) {
    return "unknown";
  }

  const evidence: BridgeTargetLiveness[] = [];
  let pane: string | undefined;
  let hasPaneAssignment = false;
  if (manifest.tmuxPaneLeftAgent === target) {
    pane = manifest.tmuxPaneLeft;
    hasPaneAssignment = true;
  } else if (manifest.tmuxPaneRightAgent === target) {
    pane = manifest.tmuxPaneRight;
    hasPaneAssignment = true;
  }
  if (hasPaneAssignment) {
    evidence.push(
      manifest.tmuxSession && pane
        ? deps.paneLiveness(manifest.tmuxSession, pane)
        : "unknown"
    );
  }

  if (target === "codex" && manifest.codexRemoteUrl && manifest.codexThreadId) {
    evidence.push(
      manifest.codexAppServerPid
        ? deps.processLiveness(manifest.codexAppServerPid)
        : "unknown"
    );
  }

  return combineTargetLiveness(evidence);
};

const resolveBridgeTargetLiveness = (
  runDir: string,
  target: BridgeTarget,
  resolver: BridgeTargetLivenessResolver | undefined,
  cache: Map<BridgeTarget, BridgeTargetLiveness>
): BridgeTargetLiveness => {
  const cached = cache.get(target);
  if (cached) {
    return cached;
  }
  let liveness: BridgeTargetLiveness = "unknown";
  try {
    const resolved = resolver
      ? resolver(target)
      : readBridgeTargetLiveness(runDir, target);
    if (resolved === "dead" || resolved === "live" || resolved === "unknown") {
      liveness = resolved;
    }
  } catch {
    // Resolver failures cannot prove that discarding a message is safe.
  }
  cache.set(target, liveness);
  return liveness;
};

export const readPendingBridgeMessages = (
  runDir: string,
  nowMs = Date.now(),
  targetLiveness?: BridgeTargetLivenessResolver,
  livenessCache = new Map<BridgeTarget, BridgeTargetLiveness>()
): BridgeMessage[] => {
  const pending = pendingFromEvents(readBridgeEvents(runDir));
  const active: BridgeMessage[] = [];
  const now = new Date(nowMs).toISOString();
  for (const message of pending) {
    const expiresAt = message.expiresAt
      ? Date.parse(message.expiresAt)
      : Number.POSITIVE_INFINITY;
    const isExpired = Number.isFinite(expiresAt) && expiresAt <= nowMs;
    const isPressureRetained = message.retainedReason === "queue-pressure";
    if (
      (isExpired || isPressureRetained) &&
      resolveBridgeTargetLiveness(
        runDir,
        message.target,
        targetLiveness,
        livenessCache
      ) === "dead"
    ) {
      const kind = isExpired ? "expired" : "dead-letter";
      appendBridgeResolution(
        runDir,
        message,
        kind,
        isExpired
          ? `expired at ${message.expiresAt}`
          : "target confirmed dead after queue pressure",
        now
      );
      continue;
    }
    active.push(message);
  }
  return active.sort(
    (left, right) =>
      bridgeMessagePriority(right) - bridgeMessagePriority(left) ||
      left.at.localeCompare(right.at) ||
      left.id.localeCompare(right.id)
  );
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

export const markBridgeMessageNotified = (
  runDir: string,
  message: BridgeMessage,
  reason?: string,
  at = new Date().toISOString()
): void => {
  appendBridgeEvent(runDir, {
    at,
    id: message.id,
    kind: "notified",
    reason,
    signature: eventSignature(message),
    source: message.source,
    target: message.target,
  });
};

export const lastBridgeNotificationAt = (
  runDir: string,
  messageId: string
): number | undefined => {
  let latest: number | undefined;
  for (const event of readBridgeEvents(runDir)) {
    if (event.kind !== "notified" || event.id !== messageId) {
      continue;
    }
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && (latest === undefined || at > latest)) {
      latest = at;
    }
  }
  return latest;
};

export const blocksBridgeBounce = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
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
    supervisor: 0,
  } satisfies Record<BridgeTarget, number>;
  for (const message of readPendingBridgeMessages(runDir).slice(
    0,
    MAX_STATUS_MESSAGES
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
    claudeBridgeMode: "mcp-config",
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
  target: BridgeTarget
): BridgeMessage[] =>
  readPendingBridgeMessages(runDir)
    .filter((message) => message.target === target)
    .slice(0, MAX_STATUS_MESSAGES);

export const formatBridgeInbox = (messages: BridgeMessage[]): string =>
  JSON.stringify(
    messages.map((message) => ({
      artifactRefs: message.artifactRefs,
      at: message.at,
      expiresAt: message.expiresAt,
      from: message.source,
      id: message.id,
      message: message.message,
      priority: message.priority ?? "normal",
      replyTo: message.replyTo,
      retainedReason: message.retainedReason,
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
  target: BridgeTarget,
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

const bridgeQueueLimits = (
  options: BridgeEnqueueOptions
): { maxOutstanding: number; maxRetained: number } => {
  const maxOutstanding =
    options.maxOutstanding ?? DEFAULT_BRIDGE_MAX_OUTSTANDING;
  const maxRetained =
    options.maxRetained ??
    (options.maxOutstanding === undefined
      ? DEFAULT_BRIDGE_MAX_RETAINED
      : maxOutstanding + 1);
  if (!(Number.isInteger(maxRetained) && maxRetained > maxOutstanding)) {
    throw new Error(
      "bridge maxRetained must be an integer greater than maxOutstanding"
    );
  }
  return { maxOutstanding, maxRetained };
};

export const enqueueBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  message: string,
  options: BridgeEnqueueOptions = {}
): BridgeEnqueueResult => {
  const entry = createBridgeMessage(source, target, message, options);
  const nowMs = Date.parse(entry.at);
  const { maxOutstanding, maxRetained } = bridgeQueueLimits(options);
  const livenessCache = new Map<BridgeTarget, BridgeTargetLiveness>();
  const pending = readPendingBridgeMessages(
    runDir,
    nowMs,
    options.targetLiveness,
    livenessCache
  );
  const duplicate = options.dedupeKey
    ? pending.find(
        (candidate) =>
          candidate.source === source &&
          candidate.target === target &&
          candidate.dedupeKey === options.dedupeKey
      )
    : undefined;
  const canonicalAck = findCanonicalBridgeAck(runDir, entry);
  if (canonicalAck) {
    supersedeBridgePredecessorForCanonicalAck(
      runDir,
      duplicate,
      canonicalAck,
      entry,
      options.supersede
    );
    return {
      entry: canonicalAck,
      reason: `existing acknowledgement ${canonicalAck.id}`,
      status: "duplicate",
    };
  }
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
  const targetPending = pending.filter(
    (candidate) => candidate.target === target && candidate.id !== duplicate?.id
  );
  const isExpired = Boolean(
    entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs
  );
  const isQueuePressure = targetPending.length >= maxOutstanding;
  const liveness =
    isExpired || isQueuePressure
      ? resolveBridgeTargetLiveness(
          runDir,
          target,
          options.targetLiveness,
          livenessCache
        )
      : undefined;

  if (
    isQueuePressure &&
    liveness !== "dead" &&
    targetPending.length >= maxRetained
  ) {
    const reason = `target retained queue limit ${maxRetained} reached`;
    return { entry, reason, status: "backpressure" };
  }

  const acceptedEntry =
    isQueuePressure && liveness !== "dead"
      ? { ...entry, retainedReason: "queue-pressure" as const }
      : entry;
  appendBridgeEvent(runDir, acceptedEntry);
  appendRunTranscriptEntry(buildTranscriptPath(runDir), {
    at: acceptedEntry.at,
    from: source,
    message,
    to: target,
  });

  if (isExpired && liveness === "dead") {
    appendBridgeResolution(
      runDir,
      acceptedEntry,
      "expired",
      `expired at ${acceptedEntry.expiresAt}`,
      acceptedEntry.at
    );
    return {
      entry: acceptedEntry,
      reason: "message already expired",
      status: "expired",
    };
  }
  if (isQueuePressure && liveness === "dead") {
    const reason = `target queue limit ${maxOutstanding} reached`;
    appendBridgeResolution(
      runDir,
      acceptedEntry,
      "dead-letter",
      reason,
      acceptedEntry.at
    );
    return { entry: acceptedEntry, reason, status: "dead-letter" };
  }
  return { entry: acceptedEntry, status: "queued" };
};

export const appendBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  message: string,
  options: BridgeEnqueueOptions = {}
): BridgeMessage => {
  const result = enqueueBridgeMessage(runDir, source, target, message, options);
  if (result.status === "backpressure") {
    throw new Error(result.reason ?? "bridge backpressure");
  }
  return result.entry;
};

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
  };
};

export const appendBlockedBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
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

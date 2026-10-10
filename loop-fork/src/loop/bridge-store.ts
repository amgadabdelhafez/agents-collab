import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS } from "./agents";
import { resolveClaudeChannelServerName } from "./bridge-config";
import { BRIDGE_SERVER } from "./bridge-constants";
import { normalizeBridgeMessage } from "./bridge-message-format";
import {
  defaultPidOwnershipDeps,
  type PidOwnershipDeps,
  pidCanStillOwnRun,
} from "./pid-ownership";
import {
  appendRunTranscriptEntry,
  buildTranscriptPath,
  readRunManifest,
} from "./run-state";
import type { Agent } from "./types";

export type BridgeSource = Agent | "supervisor" | "utility";
export type BridgeTarget = Agent | "supervisor";

const BRIDGE_FILE = "bridge.jsonl";
const BRIDGE_DEDUPE_CLAIM_DIR = "bridge-dedupe-claims";
const DEDUPE_CLAIM_TOKEN_RE = /^([1-9]\d*):[0-9a-f-]{36}\n$/;
// A claim, its reclaim marker, and that marker's own marker: deeper nesting
// needs a reclaimer killed at every level, and then fails closed (deferred).
const DEDUPE_RECLAIM_MAX_DEPTH = 3;
const DEDUPE_RECLAIM_MARKER_DIGEST = 16;
const LINE_SPLIT_RE = /\r?\n/;
const MAX_STATUS_MESSAGES = 100;
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
  kind: "notified";
  reason?: string;
}

export interface BridgeDeliveryFailure extends BridgeBaseEvent {
  kind: "delivery-failed";
  reason: string;
}

export type BridgeEvent =
  | BridgeAck
  | BridgeDeliveryFailure
  | BridgeMessage
  | BridgeNotification;

export interface BridgeEnqueueOptions {
  artifactRefs?: string[];
  dedupeKey?: string;
  dedupeResolved?: boolean;
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
  status: "queued" | "duplicate" | "deferred" | "dead-letter" | "expired";
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

export const bridgePath = (runDir: string): string => join(runDir, BRIDGE_FILE);

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

export const bridgeDedupeClaimPath = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  dedupeKey: string
): string => {
  const digest = createHash("sha256")
    .update(`${source}\n${target}\n${dedupeKey}`, "utf8")
    .digest("hex");
  return join(runDir, BRIDGE_DEDUPE_CLAIM_DIR, `${digest}.lock`);
};

/** The claim that serializes reclaiming one dead claim, named for its token. */
export const bridgeDedupeReclaimMarkerPath = (
  claimPath: string,
  token: string
): string => {
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  return `${claimPath}.reclaim-${digest.slice(0, DEDUPE_RECLAIM_MARKER_DIGEST)}`;
};

export interface BridgeDedupeClaim {
  descriptor: number;
  path: string;
  released: boolean;
  token: string;
}

interface HeldDedupeClaim {
  ownerPid: number | undefined;
  token: string;
  writtenAtMs: number;
}

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Creates the claim at `path` holding this process's `pid:uuid` token, or
 * returns undefined when a claim already exists. The token is written and
 * synced in a private staging file and then linked into place, so a claim is
 * never visible without its owner, even when its writer is killed mid-write.
 */
const createDedupeClaimFile = (path: string): BridgeDedupeClaim | undefined => {
  const token = `${process.pid}:${randomUUID()}\n`;
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(staging, "wx", 0o600);
  try {
    writeSync(descriptor, token);
    fsyncSync(descriptor);
    linkSync(staging, path);
  } catch (error) {
    closeSync(descriptor);
    if (isErrno(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      // The staging name is private to this attempt and never read as a claim.
    }
  }
  return { descriptor, path, released: false, token };
};

/** The claim at `path` with its owner and write time, "absent", or
 * undefined when it cannot be read. */
const readDedupeClaim = (
  path: string
): HeldDedupeClaim | "absent" | undefined => {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    return isErrno(error, "ENOENT") ? "absent" : undefined;
  }
  try {
    const token = readFileSync(descriptor, "utf8");
    const owner = DEDUPE_CLAIM_TOKEN_RE.exec(token)?.[1];
    return {
      ownerPid: owner ? Number(owner) : undefined,
      token,
      writtenAtMs: fstatSync(descriptor).mtimeMs,
    };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Removes the claim at `path` only when its owner provably cannot hold it,
 * on the run-release standard (`pidCanStillOwnRun`): the owner PID is not
 * alive, or is alive but started after the claim was written, so it is a
 * reused PID. A claim without a parsable owner, or whose live owner's start
 * time is unknown, stays. Reclaimers of one dead claim are serialized by a
 * claim on a marker named for its token, so a reclaimer that judged it dead
 * cannot remove a successor's live claim; a marker left by a killed
 * reclaimer is reclaimed the same way. True when `path` is free to create.
 */
const reclaimDeadDedupeClaim = (
  path: string,
  deps: PidOwnershipDeps,
  depth: number
): boolean => {
  const held = readDedupeClaim(path);
  if (held === "absent") {
    return true;
  }
  if (!held?.ownerPid || depth >= DEDUPE_RECLAIM_MAX_DEPTH) {
    return false;
  }
  const writtenAt = new Date(held.writtenAtMs).toISOString();
  if (pidCanStillOwnRun(held.ownerPid, writtenAt, deps)) {
    return false;
  }
  const marker = acquireDedupeClaimFile(
    bridgeDedupeReclaimMarkerPath(path, held.token),
    deps,
    depth + 1
  );
  if (!marker) {
    return false;
  }
  try {
    const current = readDedupeClaim(path);
    if (current === "absent") {
      return true;
    }
    if (current?.token !== held.token) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    releaseBridgeDedupeClaim(marker);
  }
};

const acquireDedupeClaimFile = (
  path: string,
  deps: PidOwnershipDeps,
  depth: number
): BridgeDedupeClaim | undefined => {
  const claim = createDedupeClaimFile(path);
  if (claim || !reclaimDeadDedupeClaim(path, deps, depth)) {
    return claim;
  }
  return createDedupeClaimFile(path);
};

/**
 * Claims one logical dedupe slot across processes. A claim left by a killed
 * process is reclaimed by the next claimant once its owner is provably dead;
 * a live owner's claim is never taken.
 */
export const acquireBridgeDedupeClaim = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  dedupeKey: string,
  deps: PidOwnershipDeps = defaultPidOwnershipDeps
): BridgeDedupeClaim | undefined => {
  const path = bridgeDedupeClaimPath(runDir, source, target, dedupeKey);
  ensureParentDir(path);
  return acquireDedupeClaimFile(path, deps, 0);
};

export const releaseBridgeDedupeClaim = (claim: BridgeDedupeClaim): void => {
  if (claim.released) {
    return;
  }
  // Fence a repeated old-owner release before closeSync: a numeric descriptor
  // can be reused by a successor claim or another file after the first close.
  claim.released = true;
  try {
    closeSync(claim.descriptor);
  } catch {
    // A repeated release still must never remove a successor owner.
  }
  try {
    if (readFileSync(claim.path, "utf8") === claim.token) {
      unlinkSync(claim.path);
    }
  } catch {
    // The claim is absent or now belongs to a different owner.
  }
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
  if (kind === "delivery-failed") {
    const reason = asString(value.reason);
    if (!reason) {
      return undefined;
    }
    return {
      ...base,
      kind,
      reason,
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
    if (event.kind === "notified" || event.kind === "delivery-failed") {
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

export const markBridgeMessageDeliveryFailed = (
  runDir: string,
  message: BridgeMessage,
  reason: string
): void => {
  const events = readBridgeEvents(runDir);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.id !== message.id || event.kind !== "delivery-failed") {
      continue;
    }
    if (event.reason === reason) {
      return;
    }
    break;
  }
  appendBridgeEvent(runDir, {
    at: new Date().toISOString(),
    id: message.id,
    kind: "delivery-failed",
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
    oss: 0,
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

const replyDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

// Reply types that report a result for the inbound they answer. Requests that
// open new work (work_request, review_request, handover, escalation) are not
// result slots: repeating one is a new request, not a duplicate result.
const RESULT_REPLY_TYPES = new Set<BridgeMessageType>(["message", "decision"]);

// Lint for the Claude result slot (owner decision 3, 2026-10-05). The slot key
// is reply_to + type + dedupe_key, so a Claude "message" reply without a
// dedupe_key takes the one keyless slot for that inbound: a progress update
// sent that way makes every later keyless message reply to the same inbound,
// usually the real result, a duplicate. The send is still accepted; the
// caller is warned so it can key interim replies.
export const keylessClaudeResultReplyWarning = (
  source: BridgeSource,
  options: Pick<BridgeEnqueueOptions, "dedupeKey" | "replyTo" | "type">
): string | undefined => {
  if (source !== "claude" || !options.replyTo || options.dedupeKey) {
    return undefined;
  }
  if ((options.type ?? "message") !== "message") {
    return undefined;
  }
  return `warning: message reply to ${options.replyTo} has no dedupe_key, so it shares the one keyless result slot for that inbound; a later keyless message reply to ${options.replyTo} (such as the result after a progress update) will be deduplicated. Give each interim progress reply its own dedupe_key.`;
};

// Resolutions after which a message never reached its recipient, so it does
// not hold its reply slot.
const NO_EFFECT_RESOLUTIONS = new Set<BridgeEvent["kind"]>([
  "dead-letter",
  "expired",
  "superseded",
]);

interface ReplySlotOptions {
  options: BridgeEnqueueOptions;
  replySlot: boolean;
}

const replySlotOptions = (
  source: BridgeSource,
  inputOptions: BridgeEnqueueOptions
): ReplySlotOptions => {
  const { replyTo } = inputOptions;
  if (!replyTo) {
    return { options: inputOptions, replySlot: false };
  }
  // An ACK acknowledges one inbound message, not each delivery notification.
  // Keep the first ACK across resolved retries and caller-supplied key drift.
  // This applies to every sender, as it did before result slots existed.
  if (inputOptions.type === "ack") {
    return {
      options: {
        ...inputOptions,
        dedupeKey: `reply-ack:${replyDigest(replyTo)}`,
        dedupeResolved: true,
        supersede: false,
      },
      replySlot: true,
    };
  }
  // Claude hears one inbound through both the MCP channel and the tmux
  // doorbell (e4efbae2), so it can act on it twice. Its result reply is one
  // durable effect per inbound and reply kind: the type plus the caller's
  // dedupe_key, so a progress update and the later result, or a decision after
  // a message, each keep their own slot. Codex and oss replies keep the
  // existing pending-only dedupe.
  const type = inputOptions.type ?? "message";
  if (source !== "claude" || !RESULT_REPLY_TYPES.has(type)) {
    return { options: inputOptions, replySlot: false };
  }
  return {
    options: {
      ...inputOptions,
      dedupeKey: `reply-result:${replyDigest(
        `${replyTo}\n${type}\n${inputOptions.dedupeKey ?? ""}`
      )}`,
      dedupeResolved: true,
    },
    replySlot: true,
  };
};

// The latest durable message holding this dedupe key. A reply that was
// dead-lettered, expired or superseded had no effect, so it does not hold its
// slot and the reply may be sent again. Other durable dedupe callers keep the
// plain lookup.
const findDurableDuplicate = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  dedupeKey: string,
  replySlot: boolean
): BridgeMessage | undefined => {
  const events = readBridgeEvents(runDir);
  const noEffect = new Set(
    replySlot
      ? events
          .filter((event) => NO_EFFECT_RESOLUTIONS.has(event.kind))
          .map((event) => event.id)
      : []
  );
  return events
    .filter(
      (candidate): candidate is BridgeMessage =>
        candidate.kind === "message" &&
        candidate.source === source &&
        candidate.target === target &&
        candidate.dedupeKey === dedupeKey &&
        !noEffect.has(candidate.id)
    )
    .at(-1);
};

export const enqueueBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
  message: string,
  inputOptions: BridgeEnqueueOptions = {}
): BridgeEnqueueResult => {
  const { options, replySlot } = replySlotOptions(source, inputOptions);
  const entry = createBridgeMessage(source, target, message, options);
  // This single synchronous critical section preserves the existing
  // queue/expiry/limit outcomes while binding durable logical dedupe to append.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one atomic decision
  const enqueue = (): BridgeEnqueueResult => {
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
    const durableDuplicate =
      options.dedupeKey && options.dedupeResolved
        ? findDurableDuplicate(
            runDir,
            source,
            target,
            options.dedupeKey,
            replySlot
          )
        : undefined;
    const retained = duplicate ?? durableDuplicate;
    // A reply slot may supersede only a still-pending reply. One that already
    // reached its recipient has had its one effect and is retained.
    const supersedes = Boolean(
      options.supersede && (duplicate !== undefined || !replySlot)
    );
    if (retained && !supersedes) {
      return {
        entry: retained,
        reason: `${durableDuplicate ? "durable" : "pending"} dedupe key ${options.dedupeKey}`,
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
    try {
      appendRunTranscriptEntry(buildTranscriptPath(runDir), {
        at: entry.at,
        from: source,
        message,
        to: target,
      });
    } catch {
      // bridge.jsonl is the durable delivery authority. A failure in the
      // compatibility transcript mirror must not hide an already-enqueued body
      // from its caller and trigger a differently keyed workflow retry.
      try {
        appendBridgeEvent(runDir, {
          at: entry.at,
          id: entry.id,
          kind: "delivery-failed",
          reason: "transcript mirror unavailable after durable bridge enqueue",
          signature: eventSignature(entry),
          source: entry.source,
          target: entry.target,
        });
      } catch {
        // The authoritative message append already succeeded. Preserve queued
        // success even if the optional diagnostic append also becomes unavailable.
      }
    }
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) {
      try {
        appendBridgeResolution(
          runDir,
          entry,
          "expired",
          `expired at ${entry.expiresAt}`,
          entry.at
        );
        return { entry, reason: "message already expired", status: "expired" };
      } catch {
        return { entry, status: "queued" };
      }
    }
    const targetPending = pending.filter(
      (candidate) =>
        candidate.target === target && candidate.id !== duplicate?.id
    );
    const maxOutstanding =
      options.maxOutstanding ?? DEFAULT_BRIDGE_MAX_OUTSTANDING;
    if (targetPending.length >= maxOutstanding) {
      const reason = `target queue limit ${maxOutstanding} reached`;
      try {
        appendBridgeResolution(runDir, entry, "dead-letter", reason, entry.at);
        return { entry, reason, status: "dead-letter" };
      } catch {
        return { entry, status: "queued" };
      }
    }
    return { entry, status: "queued" };
  };
  if (!options.dedupeKey) {
    return enqueue();
  }
  const claim = acquireBridgeDedupeClaim(
    runDir,
    source,
    target,
    options.dedupeKey
  );
  if (!claim) {
    return {
      entry,
      reason: `dedupe claim busy for ${options.dedupeKey}`,
      status: "deferred",
    };
  }
  try {
    return enqueue();
  } finally {
    releaseBridgeDedupeClaim(claim);
  }
};

export const appendBridgeMessage = (
  runDir: string,
  source: BridgeSource,
  target: BridgeTarget,
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

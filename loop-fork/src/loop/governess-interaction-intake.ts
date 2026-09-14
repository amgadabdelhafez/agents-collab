import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sleepSync } from "bun";
import { isAgent } from "./agents";
import { normalizeBridgeMessage } from "./bridge-message-format";
import { type BridgeEvent, readBridgeEvents } from "./bridge-store";
import {
  type GovernessControlRecord,
  latestGovernessControlByKey,
  prepareGovernessControl,
  transitionGovernessControl,
} from "./governess-journal";
import { decideGovernessPolicy } from "./governess-policy";
import {
  driverLeaseIsCurrent,
  type GovernessDriverLease,
  type GovernessLifecycleEvent,
} from "./governess-runtime";
import {
  type PublicAskBindingV1,
  type PublicAskRecordV1,
  publicAskAnswerResponseId,
  publicAskDecisionResponseId,
  publicAskId,
  readPublicAskRecords,
  resolvePublicAskAnswer,
  resolvePublicAskDecision,
} from "./human-interaction-ask";
import type { Agent } from "./types";

/**
 * Operator interaction-action and lifecycle-teardown requests recorded by the
 * Attention OS control surface (the producer control plane, a separate
 * checkout of this loop and not something this repository runs).
 *
 * The control surface appends a `requested` event into
 * `<runDir>/interaction-actions/events.jsonl` for one of two request shapes:
 * an interaction action (an operator answered, approved, rejected, or
 * acknowledged something from the phone or Watch) or a `lifecycle-teardown`
 * (an operator asked to end the run). This module is the whole of the
 * consumer side: it is wire-compatible with that journal (same paths, lock
 * protocol, request shapes, request-id derivations and terminal events), so
 * the producer can report the phase (pending, accepted, denied, failed) back
 * to the phone unchanged. The producer's own submission/admission path
 * (validating an inbound HTTP request, minting a request id, replaying a
 * duplicate submission) runs on the control-plane machine and is out of
 * scope here by construction: this run's Governess only ever reads requests
 * that already exist in its own run's journal.
 *
 * Ported from the producer fork's `governess-interaction-intake.ts`, which
 * builds its authority checks on a multi-run "control surface" read model
 * (`ReadModelCapabilities`, `RunLocator`, a projected `InteractionDTO`
 * reconstructed from nine kinds of raw evidence). This loop has no such
 * read model, and the run's own Governess is always the single, freshest
 * source of truth for its own run — there is no second process racing it the
 * way the producer's control surface (which serves many runs) has to guard
 * against. So the authority checks here are re-derived, not copied wire for
 * wire, from data this Governess already carries or can read directly:
 *   - `interactionEpisodeIsCurrent` recomputes the same interaction id from
 *     `input.lifecycleEvents` (this run's own live tick state) instead of a
 *     freshly-read multi-source snapshot, and requires an exact match on
 *     agent/epoch/sequence/state/at.
 *   - the ask's own state is read straight from `readPublicAskRecords`
 *     (already ported for `publish_human_ask`) rather than through a
 *     `publicAsk` source snapshot and a `selectPublicAsk` control-surface
 *     helper; `decisionResolutionState` below checks the exact same
 *     predicates (kind, open state, response mode, intent membership) the
 *     fork's `publicAskMatchesDecision` does.
 *   - `durableBridgeDecision` reads this run's bridge journal directly via
 *     `readBridgeEvents` instead of a control-surface `bridge` source
 *     snapshot.
 * What is intentionally NOT reconstructed is the fork's whole-run
 * `expectedAuthorityRevision` re-check (a digest of nine source kinds this
 * loop has no reader for) and its `interactionEntityTag` recomputation. Both
 * are additional freshness fences on top of the per-episode and per-ask
 * checks above; dropping them is a real reduction in defense-in-depth
 * against evidence drift between request creation and processing, accepted
 * here because the remaining checks already require the specific episode
 * and the specific ask to still be exactly current at process time.
 */

const ACKNOWLEDGEMENT = "Human acknowledged this interaction.";
const LOCK_ACQUIRE_TIMEOUT_MS = 2000;
const LOCK_RETRY_INTERVAL_MS = 5;
const INTAKE_VERSION = "1" as const;
const EVENT_TYPES = new Set(["requested", "accepted", "denied", "failed"]);
const INTERACTION_ACTION_DISPATCH_TIMEOUT_MS = 5000;
const MAX_INTAKE_EVENT_BYTES = 8192;
const MAX_INTAKE_EVENTS = 4096;
const MAX_INTAKE_JOURNAL_BYTES = 1024 * 1024;
const MAX_INTAKE_REQUESTS_PER_TICK = 4;
const REQUEST_ID_PATTERN = /^iar_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ASK_ID_PATTERN = /^ask_[0-9a-f]{32}$/u;
const DECISION_AUDIENCES = new Set(["desktop", "phone", "watch"]);
const LIFECYCLE_TEARDOWN_KIND = "lifecycle-teardown" as const;
const MAX_TEARDOWN_REASON_LENGTH = 200;
const TEARDOWN_REQUEST_KEYS = [
  "idempotencyKeyHash",
  "kind",
  "reason",
  "repoId",
  "requestId",
  "runId",
  "submittedAt",
  "version",
] as const;

// Minimal, self-contained ports of the wire shapes the producer's
// `control-surface/interaction-actions.ts` and `interaction-types.ts` define.
// Only the pieces this consumer actually evaluates are kept: deriving an
// action id from an interaction id and an intent, and deriving an agent
// episode's interaction id. The producer's submission-side types
// (`InteractionActionInvocation`, `InteractionActionExecutor`, HTTP route
// audiences) are not ported: this run never accepts an inbound invocation,
// only ever reads one already written to its own journal.
const INTERACTION_ID_PATTERN = /^ix_[0-9a-f]{32}$/u;
const INTERACTION_ACTION_ID_PATTERN = /^ia_[0-9a-f]{32}$/u;
const STRONG_ETAG_PATTERN = /^"[0-9a-f]{64}"$/u;

type InteractionActionIntent = "acknowledge" | "approve" | "reject" | "answer";

interface InteractionActionDTO {
  readonly confirmation: "none" | "simple" | "inspect-first";
  readonly id: string;
  readonly intent: InteractionActionIntent;
  readonly label: string;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isInteractionId = (value: unknown): value is string =>
  typeof value === "string" && INTERACTION_ID_PATTERN.test(value);

const isInteractionActionId = (value: unknown): value is string =>
  typeof value === "string" && INTERACTION_ACTION_ID_PATTERN.test(value);

const isStrongInteractionEntityTag = (value: string): boolean =>
  STRONG_ETAG_PATTERN.test(value);

export const interactionActionId = (
  interactionId: string,
  intent: InteractionActionIntent
): string =>
  `ia_${sha256(`interaction-action/v1|${interactionId}|${intent}`).slice(
    0,
    32
  )}`;

export const acknowledgeInteractionAction = (
  interactionId: string
): InteractionActionDTO => ({
  confirmation: "none",
  id: interactionActionId(interactionId, "acknowledge"),
  intent: "acknowledge",
  label: "Acknowledge",
});

export const approveInteractionAction = (
  interactionId: string
): InteractionActionDTO => ({
  confirmation: "inspect-first",
  id: interactionActionId(interactionId, "approve"),
  intent: "approve",
  label: "Approve",
});

export const rejectInteractionAction = (
  interactionId: string
): InteractionActionDTO => ({
  confirmation: "inspect-first",
  id: interactionActionId(interactionId, "reject"),
  intent: "reject",
  label: "Reject",
});

export const answerInteractionAction = (
  interactionId: string
): InteractionActionDTO => ({
  confirmation: "simple",
  id: interactionActionId(interactionId, "answer"),
  intent: "answer",
  label: "Answer",
});

/** Ported from `control-surface/interaction-projection.ts`'s `agentInteractionId`. */
export const agentInteractionId = (
  key: { readonly repoId: string; readonly runId: string },
  agent: Agent,
  epoch: number,
  sequence: number,
  state: string
): string =>
  `ix_${sha256(
    `interaction/v1|${key.repoId}|${key.runId}|agent:${agent}|${epoch}|${sequence}|${state}`
  ).slice(0, 32)}`;

type HumanDecisionIntent = "answer" | "approve" | "reject";

export type InteractionActionIntakeState =
  | "pending"
  | "accepted"
  | "denied"
  | "failed";

export interface InteractionActionIntakeRequest {
  readonly actionId: string;
  readonly agent: Agent;
  readonly askId?: string;
  readonly audience?: "desktop" | "phone" | "watch";
  readonly episode: {
    readonly at: string;
    readonly epoch: number;
    readonly sequence: number;
    readonly state: "blocked" | "failed" | "input-required";
  };
  readonly expectedAuthorityRevision?: string;
  readonly expectedEntityTag: string;
  readonly expectedSourceRevision: string;
  readonly idempotencyKeyHash: string;
  readonly intent?: HumanDecisionIntent;
  readonly interactionId: string;
  readonly payloadHash: string;
  readonly repoId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly semanticAuditCorrelation?: string;
  readonly submittedAt: string;
  readonly value?: string;
  readonly version: "1";
}

/**
 * An operator-initiated loop teardown, carried by this same intake so it
 * inherits the journal, the lock and the idempotent replay that the
 * interaction path already has. It names exactly one run: there is no
 * wildcard, no pattern and no bulk form, and the blast radius is stated by the
 * caller in `repoId`/`runId` rather than derived from anything.
 *
 * The record is a request, not an execution. Writing it kills nothing.
 * Governess is still the only mutation authority; the difference is
 * consequence, not authority.
 */
export interface LifecycleTeardownIntakeRequest {
  readonly idempotencyKeyHash: string;
  readonly kind: "lifecycle-teardown";
  readonly reason: string;
  readonly repoId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly submittedAt: string;
  readonly version: "1";
}

/**
 * Every request shape the one journal carries. An interaction action record
 * has no `kind` field and predates this union, so absence of `kind` is the
 * interaction discriminator and is enforced rather than assumed.
 */
export type IntakeRequest =
  | InteractionActionIntakeRequest
  | LifecycleTeardownIntakeRequest;

interface InteractionActionIntakeEvent {
  readonly at: string;
  readonly controlId?: string;
  readonly eventId: string;
  readonly reason?: string;
  readonly request?: IntakeRequest;
  readonly requestId: string;
  readonly type: "requested" | "accepted" | "denied" | "failed";
  readonly version: "1";
}

export interface InteractionActionIntakeSnapshot {
  readonly controlId?: string;
  readonly events: readonly InteractionActionIntakeEvent[];
  readonly reason?: string;
  readonly request: IntakeRequest;
  readonly state: InteractionActionIntakeState;
  readonly updatedAt: string;
}

interface InteractionActionIntakePaths {
  readonly eventsFile: string;
  readonly lockFile: string;
  readonly rootDir: string;
}

const intakePaths = (runDir: string): InteractionActionIntakePaths => {
  const rootDir = join(runDir, "interaction-actions");
  return {
    eventsFile: join(rootDir, "events.jsonl"),
    lockFile: join(rootDir, "events.lock"),
    rootDir,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isCanonicalTime = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
};

const isShortAnswer = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !hasControlCharacter(value);

const isInteractionActionRequest = (
  value: unknown
): value is InteractionActionIntakeRequest => {
  if (!(isRecord(value) && isRecord(value.episode))) {
    return false;
  }
  const episode = value.episode;
  const validCommon =
    value.version === INTAKE_VERSION &&
    // Absence of `kind` is the interaction discriminator. Requiring it here
    // stops a lifecycle field from riding inside an interaction record.
    value.kind === undefined &&
    isInteractionActionId(value.actionId) &&
    isAgent(value.agent as string | undefined) &&
    isCanonicalTime(episode.at) &&
    isSafeNonNegativeInteger(episode.epoch) &&
    isSafeNonNegativeInteger(episode.sequence) &&
    (episode.state === "blocked" ||
      episode.state === "failed" ||
      episode.state === "input-required") &&
    typeof value.expectedEntityTag === "string" &&
    isStrongInteractionEntityTag(value.expectedEntityTag) &&
    typeof value.expectedSourceRevision === "string" &&
    SHA256_PATTERN.test(value.expectedSourceRevision) &&
    typeof value.idempotencyKeyHash === "string" &&
    SHA256_PATTERN.test(value.idempotencyKeyHash) &&
    isInteractionId(value.interactionId) &&
    typeof value.payloadHash === "string" &&
    SHA256_PATTERN.test(value.payloadHash) &&
    typeof value.repoId === "string" &&
    value.repoId.length > 0 &&
    value.repoId.length <= 256 &&
    typeof value.requestId === "string" &&
    value.requestId ===
      `iar_${sha256(
        `${value.interactionId}|${value.actionId}|${value.idempotencyKeyHash}`
      ).slice(0, 32)}` &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    value.runId.length <= 256 &&
    isCanonicalTime(value.submittedAt);
  if (!validCommon) {
    return false;
  }
  if (episode.state === "blocked" || episode.state === "failed") {
    return (
      acknowledgeInteractionAction(String(value.interactionId)).id ===
        value.actionId &&
      value.askId === undefined &&
      value.audience === undefined &&
      value.expectedAuthorityRevision === undefined &&
      value.intent === undefined &&
      value.semanticAuditCorrelation === undefined &&
      value.value === undefined
    );
  }
  const validDecision =
    (value.intent === "approve" || value.intent === "reject") &&
    value.value === undefined &&
    value.actionId ===
      (value.intent === "approve"
        ? approveInteractionAction(String(value.interactionId)).id
        : rejectInteractionAction(String(value.interactionId)).id) &&
    value.semanticAuditCorrelation ===
      `human-decision/v1:${value.askId}:${value.intent}`;
  const validAnswer =
    value.intent === "answer" &&
    isShortAnswer(value.value) &&
    value.actionId ===
      answerInteractionAction(String(value.interactionId)).id &&
    value.semanticAuditCorrelation ===
      `human-answer/v1:${value.askId}:${sha256(value.value)}`;
  return (
    typeof value.askId === "string" &&
    ASK_ID_PATTERN.test(value.askId) &&
    typeof value.audience === "string" &&
    DECISION_AUDIENCES.has(value.audience) &&
    typeof value.expectedAuthorityRevision === "string" &&
    SHA256_PATTERN.test(value.expectedAuthorityRevision) &&
    (validDecision || validAnswer)
  );
};

/**
 * Derive a teardown request id from the exact run it names. The domain string
 * differs from the interaction one, so the two derivations cannot collide, and
 * the `iar_` shape keeps `REQUEST_ID_PATTERN` unchanged. Identical to the
 * producer's derivation (and to this loop's own prior teardown-only reader),
 * so ids agree across builds.
 */
export const lifecycleTeardownRequestId = (
  repoId: string,
  runId: string,
  idempotencyKeyHash: string
): string =>
  `iar_${sha256(
    `${LIFECYCLE_TEARDOWN_KIND}|${repoId}|${runId}|${idempotencyKeyHash}`
  ).slice(0, 32)}`;

/** @deprecated Use {@link lifecycleTeardownRequestId}; kept for the prior name. */
export const teardownRequestId = lifecycleTeardownRequestId;

const isBoundedIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !hasControlCharacter(value);

export const isTeardownReason = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_TEARDOWN_REASON_LENGTH &&
  value.trim() === value &&
  !hasControlCharacter(value);

/**
 * Validate a teardown record structurally, including an exact key set. An
 * unknown key is refused rather than ignored: a record this consequential must
 * not carry a field that no reader here understands.
 */
const isLifecycleTeardownRequest = (
  value: unknown
): value is LifecycleTeardownIntakeRequest => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== TEARDOWN_REQUEST_KEYS.length ||
    !keys.every((key) =>
      (TEARDOWN_REQUEST_KEYS as readonly string[]).includes(key)
    )
  ) {
    return false;
  }
  return (
    value.version === INTAKE_VERSION &&
    value.kind === LIFECYCLE_TEARDOWN_KIND &&
    isBoundedIdentifier(value.repoId) &&
    isBoundedIdentifier(value.runId) &&
    isTeardownReason(value.reason) &&
    typeof value.idempotencyKeyHash === "string" &&
    SHA256_PATTERN.test(value.idempotencyKeyHash) &&
    typeof value.requestId === "string" &&
    value.requestId ===
      lifecycleTeardownRequestId(
        value.repoId,
        value.runId,
        value.idempotencyKeyHash
      ) &&
    isCanonicalTime(value.submittedAt)
  );
};

/** @deprecated Use {@link isRequest}/`isEvent`; kept for the prior name. */
export const isTeardownRequest = isLifecycleTeardownRequest;

/** Narrow a journalled request to the lifecycle variant. */
export const isLifecycleTeardown = (
  request: IntakeRequest
): request is LifecycleTeardownIntakeRequest =>
  (request as { readonly kind?: unknown }).kind === LIFECYCLE_TEARDOWN_KIND;

/**
 * A `requested` event whose embedded request declares a `kind` this reader
 * does not recognize (neither the interaction-action shape, which carries no
 * `kind` at all, nor `"lifecycle-teardown"`). The producer control surface is
 * a separate, independently-evolving checkout; a future request kind it adds
 * must be forward-compatible here rather than poisoning the whole journal for
 * every OTHER pending request in the same run. Such a record is accepted at
 * the wire level and then left untouched: never folded into a pending
 * snapshot, never executed, and never a reason to fail closed.
 */
const isUnrecognizedRequestKind = (value: unknown): boolean =>
  isRecord(value) &&
  value.kind !== undefined &&
  value.kind !== LIFECYCLE_TEARDOWN_KIND;

const isRequest = (value: unknown): value is IntakeRequest =>
  isInteractionActionRequest(value) || isLifecycleTeardownRequest(value);

/**
 * Structural validation for one journal line. Returns `"known"` for a
 * recognized, fully-valid event; `"unknown"` for a `requested` event whose
 * request kind this reader does not understand (forward-compatible, never
 * folded); `false` for anything else, which is a hard failure.
 */
const classifyEvent = (
  value: unknown
): "known" | "unknown" | false => {
  if (
    !(
      isRecord(value) &&
      value.version === INTAKE_VERSION &&
      isCanonicalTime(value.at) &&
      typeof value.eventId === "string" &&
      value.eventId.length > 0 &&
      value.eventId.length <= 160 &&
      // The `iar_`+hex shape is only required once a request is recognized,
      // below: an unrecognized future kind may carry a request id in a shape
      // this reader does not define, just as a bounded, non-empty string.
      typeof value.requestId === "string" &&
      value.requestId.length > 0 &&
      value.requestId.length <= 256 &&
      typeof value.type === "string" &&
      EVENT_TYPES.has(value.type) &&
      (value.controlId === undefined ||
        (typeof value.controlId === "string" &&
          value.controlId.length > 0 &&
          value.controlId.length <= 160)) &&
      (value.reason === undefined ||
        (typeof value.reason === "string" &&
          value.reason.length > 0 &&
          value.reason.length <= 256))
    )
  ) {
    return false;
  }
  if (value.type !== "requested") {
    return value.request === undefined ? "known" : false;
  }
  // An unrecognized request kind is an opaque future shape: check only the
  // envelope (already validated above), not an inner requestId/eventId
  // consistency this reader has no basis to require of a shape it does not
  // define.
  if (isUnrecognizedRequestKind(value.request)) {
    return value.controlId === undefined && value.reason === undefined
      ? "unknown"
      : false;
  }
  if (
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    value.requestId !== (value.request as { requestId?: unknown })?.requestId ||
    value.eventId !== `requested:${value.requestId}` ||
    value.controlId !== undefined ||
    value.reason !== undefined
  ) {
    return false;
  }
  if (isRequest(value.request)) {
    return "known";
  }
  return isUnrecognizedRequestKind(value.request) ? "unknown" : false;
};

const readEvents = (path: string): InteractionActionIntakeEvent[] => {
  const parentPath = dirname(path);
  const directoryFlags =
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW;
  let directory: number | undefined;
  let descriptor: number | undefined;
  try {
    directory = openSync(parentPath, directoryFlags);
    assertSafeDirectoryDescriptor(parentPath, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error("interaction action intake root is unsafe");
  }
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        assertSafeDirectoryDescriptor(parentPath, directory);
      } finally {
        closeSync(directory);
      }
      return [];
    }
    closeSync(directory);
    throw new Error("interaction action intake journal is unsafe");
  }
  try {
    const before = assertSafeJournalDescriptor(path, descriptor);
    assertSafeDirectoryDescriptor(parentPath, directory);
    const text = readFileSync(descriptor, "utf8");
    const after = assertSafeJournalDescriptor(path, descriptor);
    assertSafeDirectoryDescriptor(parentPath, directory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("interaction action intake journal changed during read");
    }
    return parseEvents(text);
  } finally {
    closeSync(descriptor);
    closeSync(directory);
  }
};

const parseEvents = (text: string): InteractionActionIntakeEvent[] => {
  if (!text) {
    return [];
  }
  const events: InteractionActionIntakeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    if (Buffer.byteLength(line) > MAX_INTAKE_EVENT_BYTES) {
      throw new Error("interaction action intake event is oversized");
    }
    const parsed = JSON.parse(line) as unknown;
    const classification = classifyEvent(parsed);
    if (classification === false) {
      throw new Error("interaction action intake journal is invalid");
    }
    if (classification === "known") {
      events.push(parsed as InteractionActionIntakeEvent);
    }
    // "unknown" is accepted at the wire level and dropped here: it is never
    // folded into a snapshot, so it can neither become pending nor collide
    // with a later terminal event for the same request id.
    if (events.length > MAX_INTAKE_EVENTS) {
      throw new Error("interaction action intake journal has too many events");
    }
  }
  return events;
};

const assertSafeJournalDescriptor = (
  path: string,
  descriptor: number
): BigIntStats => {
  const descriptorStats = fstatSync(descriptor, { bigint: true });
  const pathStats = lstatSync(path, { bigint: true });
  if (
    !descriptorStats.isFile() ||
    descriptorStats.isSymbolicLink() ||
    descriptorStats.nlink !== 1n ||
    descriptorStats.size > BigInt(MAX_INTAKE_JOURNAL_BYTES) ||
    pathStats.isSymbolicLink() ||
    pathStats.dev !== descriptorStats.dev ||
    pathStats.ino !== descriptorStats.ino
  ) {
    throw new Error("interaction action intake journal is unsafe");
  }
  return descriptorStats;
};

const foldSnapshots = (
  events: readonly InteractionActionIntakeEvent[]
): InteractionActionIntakeSnapshot[] => {
  const snapshots = new Map<string, InteractionActionIntakeSnapshot>();
  for (const event of events) {
    if (event.type === "requested") {
      if (!event.request || snapshots.has(event.requestId)) {
        throw new Error("interaction action intake request is duplicated");
      }
      snapshots.set(event.requestId, {
        events: [event],
        request: event.request,
        state: "pending",
        updatedAt: event.at,
      });
      continue;
    }
    const current = snapshots.get(event.requestId);
    if (!current) {
      // A terminal event with no known pending request is either for a
      // request whose kind this reader treated as forward-compatible and
      // never folded, or for one from before this run's journal window. It
      // is not this reader's concern to resolve; skip rather than fail the
      // whole journal closed.
      continue;
    }
    if (current.state !== "pending") {
      throw new Error("interaction action intake transition is invalid");
    }
    snapshots.set(event.requestId, {
      ...(event.controlId ? { controlId: event.controlId } : {}),
      events: [...current.events, event],
      ...(event.reason ? { reason: event.reason } : {}),
      request: current.request,
      state: event.type,
      updatedAt: event.at,
    });
  }
  return [...snapshots.values()];
};

export const readInteractionActionIntake = (
  runDir: string
): InteractionActionIntakeSnapshot[] =>
  foldSnapshots(readEvents(intakePaths(runDir).eventsFile));

/** Pending lifecycle-teardown requests for this run, oldest first. */
export const pendingTeardowns = (
  runDir: string
): LifecycleTeardownIntakeRequest[] =>
  readInteractionActionIntake(runDir)
    .filter(
      (snapshot) =>
        snapshot.state === "pending" && isLifecycleTeardown(snapshot.request)
    )
    .map((snapshot) => snapshot.request as LifecycleTeardownIntakeRequest);

const createLock = (
  lockFile: string
): { readonly descriptor: number; readonly token: string } => {
  const token = randomUUID();
  const descriptor = openSync(lockFile, "wx", 0o600);
  writeAll(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
  fsyncSync(descriptor);
  return { descriptor, token };
};

const lockRecord = (
  lockFile: string
): { readonly pid: number; readonly token: string } | undefined => {
  try {
    const value = JSON.parse(readFileSync(lockFile, "utf8")) as unknown;
    return isRecord(value) &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string"
      ? { pid: Number(value.pid), token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
};

const acquireLock = (
  lockFile: string
): { readonly descriptor: number; readonly token: string } => {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      return createLock(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("interaction action intake is busy");
      }
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
};

const withIntakeLock = async <T>(
  runDir: string,
  operation: (paths: InteractionActionIntakePaths) => T | Promise<T>
): Promise<T> => {
  const paths = intakePaths(runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  if (!lstatSync(paths.rootDir).isDirectory()) {
    throw new Error("interaction action intake root is unsafe");
  }
  const lock = acquireLock(paths.lockFile);
  try {
    return await operation(paths);
  } finally {
    closeSync(lock.descriptor);
    try {
      if (lockRecord(paths.lockFile)?.token === lock.token) {
        unlinkSync(paths.lockFile);
      }
    } catch {
      // A later read still validates the complete journal.
    }
  }
};

const appendEvent = (
  path: string,
  event: InteractionActionIntakeEvent
): void => {
  const parentPath = dirname(path);
  mkdirSync(parentPath, { recursive: true });
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded) > MAX_INTAKE_EVENT_BYTES) {
    throw new Error("interaction action intake event is oversized");
  }
  const directoryFlags =
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW;
  const directory = openSync(parentPath, directoryFlags);
  let descriptor: number | undefined;
  let created = false;
  try {
    assertSafeDirectoryDescriptor(parentPath, directory);
    try {
      const createFlags =
        constants.O_RDWR +
        constants.O_APPEND +
        constants.O_CREAT +
        constants.O_EXCL +
        constants.O_NOFOLLOW;
      descriptor = openSync(path, createFlags, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const appendFlags =
        constants.O_RDWR + constants.O_APPEND + constants.O_NOFOLLOW;
      descriptor = openSync(path, appendFlags);
    }
    const before = assertSafeJournalDescriptor(path, descriptor);
    assertSafeDirectoryDescriptor(parentPath, directory);
    const events = parseEvents(readFileSync(descriptor, "utf8"));
    const afterRead = assertSafeJournalDescriptor(path, descriptor);
    if (
      before.dev !== afterRead.dev ||
      before.ino !== afterRead.ino ||
      before.size !== afterRead.size ||
      before.mtimeNs !== afterRead.mtimeNs ||
      before.ctimeNs !== afterRead.ctimeNs
    ) {
      throw new Error("interaction action intake journal changed during read");
    }
    if (
      events.length >= MAX_INTAKE_EVENTS ||
      afterRead.size + BigInt(Buffer.byteLength(encoded)) >
        BigInt(MAX_INTAKE_JOURNAL_BYTES)
    ) {
      throw new Error("interaction action intake journal is unsafe");
    }
    writeAll(descriptor, encoded);
    fsyncSync(descriptor);
    const afterWrite = assertSafeJournalDescriptor(path, descriptor);
    if (
      afterWrite.dev !== afterRead.dev ||
      afterWrite.ino !== afterRead.ino ||
      afterWrite.size !== afterRead.size + BigInt(Buffer.byteLength(encoded))
    ) {
      throw new Error("interaction action intake journal write was unstable");
    }
    assertSafeDirectoryDescriptor(parentPath, directory);
    if (created) {
      fsyncSync(directory);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      closeSync(directory);
    } catch {
      // The journal result is already determined by the descriptor checks.
    }
  }
};

const assertSafeDirectoryDescriptor = (
  path: string,
  descriptor: number
): BigIntStats => {
  const descriptorStats = fstatSync(descriptor, { bigint: true });
  const pathStats = lstatSync(path, { bigint: true });
  if (
    !descriptorStats.isDirectory() ||
    descriptorStats.isSymbolicLink() ||
    pathStats.isSymbolicLink() ||
    pathStats.dev !== descriptorStats.dev ||
    pathStats.ino !== descriptorStats.ino
  ) {
    throw new Error("interaction action intake root is unsafe");
  }
  return descriptorStats;
};

const writeAll = (descriptor: number, value: string): void => {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset
    );
    if (written <= 0) {
      throw new Error("interaction action intake write was incomplete");
    }
    offset += written;
  }
};

const preparedMatches = (
  prepared: GovernessControlRecord,
  request: InteractionActionIntakeRequest,
  epoch: number
): boolean =>
  prepared.action ===
    (request.intent ? "deliver-human-decision" : "send-control") &&
  prepared.agent === request.agent &&
  prepared.epoch === epoch &&
  prepared.idempotencyKey ===
    (request.semanticAuditCorrelation ??
      `interaction/v1:${request.interactionId}:${request.actionId}`) &&
  prepared.payloadHash ===
    sha256(request.value ?? request.intent ?? ACKNOWLEDGEMENT) &&
  prepared.policyClass ===
    (request.intent ? "require-confirmation" : "safe-automatic") &&
  JSON.stringify(prepared.policyContext) ===
    JSON.stringify(
      request.intent
        ? { confirmed: true, fenceCurrent: true }
        : { fenceCurrent: true, targetSafe: true }
    );

const regularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export interface InteractionActionAuthorityInput {
  readonly agents: readonly Agent[];
  readonly dispatch: (input: {
    readonly agent: Agent;
    readonly controlId: string;
    readonly message: string;
    readonly subject?: "human decision";
    readonly threadId?: string;
    readonly type?: "decision";
  }) => Promise<{
    readonly reason?: string;
    readonly status: "accepted" | "delivered" | "queued";
  }>;
  /** Test/embedded override; live Governess uses the fixed five-second bound. */
  readonly dispatchTimeoutMs?: number;
  readonly driverLease?: GovernessDriverLease;
  readonly epoch: number;
  readonly fenceCurrent: () => boolean;
  readonly journalFile?: string;
  readonly lifecycleEvents: Partial<Record<Agent, GovernessLifecycleEvent>>;
  readonly now: () => number;
  readonly repoId: string;
  readonly runDir: string;
  readonly runId: string;
  /**
   * Perform the teardown this run already knows how to do. Governess supplies
   * `stopGovernessLoop`; a caller that supplies nothing gets a recorded
   * failure, never a silent success.
   */
  readonly teardown?: (reason: string) => void;
}

type HumanDecisionIntakeRequest = InteractionActionIntakeRequest & {
  readonly askId: string;
  readonly audience: "desktop" | "phone" | "watch";
  readonly episode: InteractionActionIntakeRequest["episode"] & {
    readonly state: "input-required";
  };
  readonly expectedAuthorityRevision: string;
  readonly intent: HumanDecisionIntent;
  readonly semanticAuditCorrelation: string;
};

const isHumanDecisionRequest = (
  request: InteractionActionIntakeRequest
): request is HumanDecisionIntakeRequest =>
  request.episode.state === "input-required" &&
  Boolean(
    request.askId &&
      request.audience &&
      request.expectedAuthorityRevision &&
      request.intent &&
      request.semanticAuditCorrelation
  );

const interactionEpisodeIsCurrent = (
  request: InteractionActionIntakeRequest,
  input: InteractionActionAuthorityInput
): boolean => {
  const event = input.lifecycleEvents[request.agent];
  return !(
    request.repoId !== input.repoId ||
    request.runId !== input.runId ||
    !input.agents.includes(request.agent) ||
    !event ||
    event.agent !== request.agent ||
    event.at !== request.episode.at ||
    event.epoch !== input.epoch ||
    event.epoch !== request.episode.epoch ||
    event.sequence !== request.episode.sequence ||
    event.state !== request.episode.state ||
    agentInteractionId(
      { repoId: request.repoId, runId: request.runId },
      request.agent,
      event.epoch,
      event.sequence,
      event.state
    ) !== request.interactionId
  );
};

const commonAuthorityReason = (
  request: InteractionActionIntakeRequest,
  input: InteractionActionAuthorityInput
): string | undefined => {
  if (!input.fenceCurrent()) {
    return "stale-governess-fence";
  }
  if (
    !(
      input.driverLease &&
      driverLeaseIsCurrent(input.driverLease, input.epoch, input.now())
    )
  ) {
    return "driver-lease-unavailable";
  }
  return interactionEpisodeIsCurrent(request, input)
    ? undefined
    : "interaction-episode-stale";
};

/**
 * A decision's ask-specific authority (still open, still the same kind and
 * response mode, still accepting this intent) is established earlier by
 * `decisionResolutionState`, which reads the same `PublicAskRecordV1` this
 * would. What remains here is the run-level authority every action needs:
 * the fence, the driver lease and the episode.
 */
const decisionAuthorityReason = (
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput
): string | undefined => {
  const common = commonAuthorityReason(request, input);
  if (common) {
    return common;
  }
  const policy = decideGovernessPolicy("deliver-human-decision", {
    confirmed: true,
    fenceCurrent: true,
  });
  return policy.allowed && policy.class === "require-confirmation"
    ? undefined
    : `policy-denied:${policy.reason}`;
};

const acknowledgementDenialReason = (
  request: InteractionActionIntakeRequest,
  input: InteractionActionAuthorityInput
): string | undefined => {
  const common = commonAuthorityReason(request, input);
  if (common) {
    return common;
  }
  if (
    acknowledgeInteractionAction(request.interactionId).id !== request.actionId
  ) {
    return "interaction-episode-stale";
  }
  const policy = decideGovernessPolicy("send-control", {
    fenceCurrent: true,
    targetSafe: true,
  });
  if (!policy.allowed) {
    return `policy-denied:${policy.reason}`;
  }
  if (!(input.journalFile && regularFile(input.journalFile))) {
    return "authority-journal-unavailable";
  }
  return undefined;
};

const terminalEvent = (
  requestId: string,
  type: "accepted" | "denied" | "failed",
  now: number,
  details: { readonly controlId?: string; readonly reason?: string } = {}
): InteractionActionIntakeEvent => ({
  at: new Date(now).toISOString(),
  ...(details.controlId ? { controlId: details.controlId } : {}),
  eventId: `${type}:${requestId}:${randomUUID()}`,
  ...(details.reason ? { reason: details.reason } : {}),
  requestId,
  type,
  version: INTAKE_VERSION,
});

export const processPendingInteractionActions = async (
  input: InteractionActionAuthorityInput
): Promise<number> =>
  await withIntakeLock(input.runDir, async (paths) => {
    const pending = foldSnapshots(readEvents(paths.eventsFile))
      .filter((snapshot) => snapshot.state === "pending")
      .slice(0, MAX_INTAKE_REQUESTS_PER_TICK);
    for (const snapshot of pending) {
      await processPendingSnapshot(paths.eventsFile, snapshot.request, input);
    }
    return pending.length;
  });

/**
 * Execute pending operator lifecycle-teardown requests for this run outside
 * the interaction-action authority path (there is no dispatch, driver lease,
 * or agent episode involved). Kept as a distinct entry point, matching the
 * one this loop had before the full intake existed, since teardown has its
 * own minimal input shape and its own callers.
 */
export interface TeardownIntakeInput {
  readonly fenceCurrent: () => boolean;
  readonly now: () => number;
  readonly repoId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly teardown: (reason: string) => void;
}

export const processPendingTeardowns = (input: TeardownIntakeInput): number => {
  if (pendingTeardowns(input.runDir).length === 0) {
    return 0;
  }
  const paths = intakePaths(input.runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  if (!lstatSync(paths.rootDir).isDirectory()) {
    throw new Error("interaction action intake root is unsafe");
  }
  const lock = acquireLock(paths.lockFile);
  let processed = 0;
  try {
    // Re-read while holding the lock: the unlocked check above is only an
    // early exit, not the authority for what gets processed.
    const pending = foldSnapshots(readEvents(paths.eventsFile)).filter(
      (snapshot) =>
        snapshot.state === "pending" && isLifecycleTeardown(snapshot.request)
    );
    for (const snapshot of pending) {
      const request = snapshot.request as LifecycleTeardownIntakeRequest;
      if (
        !(request.repoId === input.repoId && request.runId === input.runId)
      ) {
        appendEvent(
          paths.eventsFile,
          terminalEvent(request.requestId, "denied", input.now(), {
            reason: "lifecycle-run-mismatch",
          })
        );
        processed += 1;
        continue;
      }
      if (!input.fenceCurrent()) {
        continue;
      }
      appendEvent(
        paths.eventsFile,
        terminalEvent(request.requestId, "accepted", input.now())
      );
      processed += 1;
      // Teardown executes at most one request per call: `teardown` normally
      // tears down the very process running this loop.
      input.teardown(request.reason);
      break;
    }
  } finally {
    closeSync(lock.descriptor);
    try {
      if (lockRecord(paths.lockFile)?.token === lock.token) {
        unlinkSync(paths.lockFile);
      }
    } catch {
      // A later read still validates the complete journal.
    }
  }
  return processed;
};

const recordTerminal = (
  eventsFile: string,
  requestId: string,
  type: "accepted" | "denied" | "failed",
  input: InteractionActionAuthorityInput,
  details: { readonly controlId?: string; readonly reason?: string } = {}
): void =>
  appendEvent(eventsFile, terminalEvent(requestId, type, input.now(), details));

const decisionBinding = (
  request: HumanDecisionIntakeRequest
): PublicAskBindingV1 => ({
  agent: request.agent,
  epoch: request.episode.epoch,
  repoId: request.repoId,
  runId: request.runId,
  sequence: request.episode.sequence,
});

/**
 * Ported from the fork's `selectPublicAsk`, minus the control-surface
 * `PublicAskSourceSnapshot` wrapper: this reads the ask directly from
 * `readPublicAskRecords` instead of a `publicAsk` source snapshot.
 */
const selectPublicAskRecord = (
  records: readonly PublicAskRecordV1[],
  binding: PublicAskBindingV1
): PublicAskRecordV1 | undefined => {
  const expectedId = publicAskId(binding);
  const selected = records.filter((record) => record.id === expectedId);
  return selected.length === 1 &&
    JSON.stringify(selected[0]?.binding) === JSON.stringify(binding)
    ? selected[0]
    : undefined;
};

const decisionResolutionState = (
  request: HumanDecisionIntakeRequest,
  runDir: string
): "conflict" | "matching" | "open" | "unavailable" => {
  let records: PublicAskRecordV1[];
  try {
    records = readPublicAskRecords(runDir);
  } catch {
    return "unavailable";
  }
  const ask = selectPublicAskRecord(records, decisionBinding(request));
  if (
    !ask ||
    ask.kind !== (request.intent === "answer" ? "question" : "approval") ||
    ask.response.mode !==
      (request.intent === "answer" ? "short-answer" : "approve-reject") ||
    !ask.response.intents.includes(request.intent)
  ) {
    return "unavailable";
  }
  if (ask.state === "open") {
    return "open";
  }
  const responseId =
    request.intent === "answer"
      ? publicAskAnswerResponseId(request.askId, request.value as string)
      : publicAskDecisionResponseId(request.askId, request.intent);
  return ask.responseCorrelation?.responseId === responseId
    ? "matching"
    : "conflict";
};

const resolveDecision = (
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput
): void => {
  if (request.intent === "answer") {
    resolvePublicAskAnswer(input.runDir, {
      askId: request.askId,
      binding: decisionBinding(request),
      resolvedAt: new Date(input.now()).toISOString(),
      value: request.value as string,
    });
    return;
  }
  resolvePublicAskDecision(input.runDir, {
    askId: request.askId,
    binding: decisionBinding(request),
    intent: request.intent,
    resolvedAt: new Date(input.now()).toISOString(),
  });
};

const BRIDGE_FAILURE_KINDS = new Set([
  "blocked",
  "expired",
  "superseded",
  "dead-letter",
]);

/**
 * Ported from the fork's `durableBridgeDecision`, reading this run's own
 * bridge journal directly via `readBridgeEvents` instead of a control-surface
 * `bridge` source snapshot. `readBridgeEvents` already discards malformed
 * lines and verifies each event's signature, so there is no separate
 * `validBridgeSnapshot` pass here.
 */
const durableBridgeDecision = (
  request: HumanDecisionIntakeRequest,
  controlId: string,
  runDir: string
): "absent" | "accepted" | "conflict" => {
  let events: BridgeEvent[];
  try {
    events = readBridgeEvents(runDir);
  } catch {
    return "conflict";
  }
  const messages = events.filter(
    (event): event is Extract<BridgeEvent, { kind: "message" }> =>
      event.kind === "message" && event.dedupeKey === controlId
  );
  if (messages.length === 0) {
    return "absent";
  }
  if (messages.length !== 1) {
    return "conflict";
  }
  const message = messages[0];
  if (
    !(
      message.source === "supervisor" &&
      message.target === request.agent &&
      (message.priority ?? "normal") === "normal" &&
      message.type === "decision" &&
      message.threadId === request.askId &&
      message.subject === "human decision" &&
      message.message === (request.value ?? request.intent)
    )
  ) {
    return "conflict";
  }
  const terminal = events.find(
    (event) => event.id === message.id && BRIDGE_FAILURE_KINDS.has(event.kind)
  );
  return terminal ? "conflict" : "accepted";
};

const exactDispatchedDecisionControl = (
  request: HumanDecisionIntakeRequest,
  journalFile: string,
  controlId: string
): boolean => {
  try {
    const current = latestGovernessControlByKey(
      journalFile,
      request.semanticAuditCorrelation
    );
    return Boolean(
      current &&
        current.controlId === controlId &&
        current.phase === "dispatched" &&
        preparedMatches(current, request, request.episode.epoch)
    );
  } catch {
    return false;
  }
};

const acceptDurableDecision = (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  journalFile: string,
  controlId: string
): boolean => {
  if (
    !exactDispatchedDecisionControl(request, journalFile, controlId) ||
    durableBridgeDecision(request, controlId, input.runDir) !== "accepted"
  ) {
    return false;
  }
  const accepted = transitionGovernessControl(
    journalFile,
    controlId,
    "accepted",
    new Date(input.now()).toISOString(),
    undefined,
    { evidence: "bridge:durable-decision", transport: "bridge" }
  );
  if (!accepted) {
    throw new Error("human decision acceptance was not recorded");
  }
  resolveDecision(request, input);
  recordTerminal(eventsFile, request.requestId, "accepted", input, {
    controlId,
  });
  return true;
};

const dispatchWithinBound = async <T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  const boundedTimeoutMs = Math.max(
    1,
    Math.min(timeoutMs, INTERACTION_ACTION_DISPATCH_TIMEOUT_MS)
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("interaction action dispatch timed out")),
          boundedTimeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const dispatchPreparedHumanDecision = async (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  journalFile: string,
  prepared: GovernessControlRecord
): Promise<void> => {
  const dispatched = transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "dispatched",
    new Date(input.now()).toISOString(),
    undefined,
    { transport: "bridge" }
  );
  if (
    !(
      dispatched && preparedMatches(dispatched, request, request.episode.epoch)
    ) ||
    dispatched.phase !== "dispatched" ||
    !exactDispatchedDecisionControl(request, journalFile, prepared.controlId)
  ) {
    return;
  }
  if (decisionAuthorityReason(request, input)) {
    return;
  }
  try {
    await dispatchWithinBound(
      input.dispatch({
        agent: request.agent,
        controlId: prepared.controlId,
        message: request.value ?? request.intent,
        subject: "human decision",
        threadId: request.askId,
        type: "decision",
      }),
      input.dispatchTimeoutMs ?? INTERACTION_ACTION_DISPATCH_TIMEOUT_MS
    );
  } catch {
    acceptDurableDecision(
      eventsFile,
      request,
      input,
      journalFile,
      prepared.controlId
    );
    return;
  }
  // A successful dispatch is not itself durable evidence: only a matching,
  // unfailed message in this run's own bridge journal is. `delivery.status`
  // is intentionally unused here (upstream's dispatch never reports
  // dead-letter/expired; those surface as a thrown rejection instead, handled
  // above), so the control stays "dispatched" until `acceptDurableDecision`
  // observes the bridge journal confirm it — on this call or a later tick.
  acceptDurableDecision(
    eventsFile,
    request,
    input,
    journalFile,
    prepared.controlId
  );
};

const dispatchPreparedAcknowledgement = async (
  eventsFile: string,
  request: InteractionActionIntakeRequest,
  input: InteractionActionAuthorityInput,
  journalFile: string,
  prepared: GovernessControlRecord
): Promise<void> => {
  const dispatched = transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "dispatched",
    new Date(input.now()).toISOString(),
    undefined,
    { transport: "bridge" }
  );
  if (!dispatched) {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      controlId: prepared.controlId,
      reason: "authority-dispatch-unrecorded",
    });
    return;
  }
  let delivery: Awaited<
    ReturnType<InteractionActionAuthorityInput["dispatch"]>
  >;
  try {
    delivery = await dispatchWithinBound(
      input.dispatch({
        agent: request.agent,
        controlId: prepared.controlId,
        message: ACKNOWLEDGEMENT,
      }),
      input.dispatchTimeoutMs ?? INTERACTION_ACTION_DISPATCH_TIMEOUT_MS
    );
  } catch {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      controlId: prepared.controlId,
      reason: "bridge-dispatch-ambiguous",
    });
    return;
  }
  const accepted = transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "accepted",
    new Date(input.now()).toISOString(),
    undefined,
    { evidence: `bridge:${delivery.status}`, transport: "bridge" }
  );
  recordTerminal(
    eventsFile,
    request.requestId,
    accepted ? "accepted" : "failed",
    input,
    {
      controlId: prepared.controlId,
      ...(accepted ? {} : { reason: "authority-acceptance-unrecorded" }),
    }
  );
};

const decisionControl = (
  request: HumanDecisionIntakeRequest,
  journalFile: string
): GovernessControlRecord | undefined =>
  latestGovernessControlByKey(journalFile, request.semanticAuditCorrelation);

const prepareHumanDecisionControl = (
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  journalFile: string
): GovernessControlRecord =>
  prepareGovernessControl(journalFile, {
    action: "deliver-human-decision",
    agent: request.agent,
    at: new Date(input.now()).toISOString(),
    epoch: input.epoch,
    idempotencyKey: request.semanticAuditCorrelation,
    payload: request.value ?? request.intent,
    policyClass: "require-confirmation",
    policyContext: { confirmed: true, fenceCurrent: true },
  });

const recordDecisionDenial = (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  reason: string
): void =>
  recordTerminal(eventsFile, request.requestId, "denied", input, { reason });

const processResolvedDecision = (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  control: GovernessControlRecord | undefined
): void => {
  const acceptedPhases = new Set(["accepted", "acknowledged", "completed"]);
  if (
    control &&
    preparedMatches(control, request, request.episode.epoch) &&
    acceptedPhases.has(control.phase) &&
    durableBridgeDecision(request, control.controlId, input.runDir) ===
      "accepted"
  ) {
    recordTerminal(eventsFile, request.requestId, "accepted", input, {
      controlId: control.controlId,
    });
    return;
  }
  recordDecisionDenial(
    eventsFile,
    request,
    input,
    "decision-resolution-without-accepted-control"
  );
};

const processOpenDecisionControl = async (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput,
  journalFile: string,
  control: GovernessControlRecord | undefined
): Promise<void> => {
  if (!control) {
    const denied = decisionAuthorityReason(request, input);
    if (denied) {
      recordDecisionDenial(eventsFile, request, input, denied);
      return;
    }
    const prepared = prepareHumanDecisionControl(request, input, journalFile);
    if (!preparedMatches(prepared, request, request.episode.epoch)) {
      recordDecisionDenial(
        eventsFile,
        request,
        input,
        "authority-journal-collision"
      );
      return;
    }
    await dispatchPreparedHumanDecision(
      eventsFile,
      request,
      input,
      journalFile,
      prepared
    );
    return;
  }
  if (!preparedMatches(control, request, request.episode.epoch)) {
    recordDecisionDenial(
      eventsFile,
      request,
      input,
      "authority-journal-collision"
    );
    return;
  }
  if (control.phase === "prepared") {
    const denied = decisionAuthorityReason(request, input);
    if (denied) {
      recordDecisionDenial(eventsFile, request, input, denied);
      return;
    }
    await dispatchPreparedHumanDecision(
      eventsFile,
      request,
      input,
      journalFile,
      control
    );
    return;
  }
  if (control.phase === "dispatched") {
    acceptDurableDecision(
      eventsFile,
      request,
      input,
      journalFile,
      control.controlId
    );
    return;
  }
  if (
    control.phase === "accepted" ||
    control.phase === "acknowledged" ||
    control.phase === "completed"
  ) {
    if (
      durableBridgeDecision(request, control.controlId, input.runDir) ===
      "accepted"
    ) {
      resolveDecision(request, input);
      recordTerminal(eventsFile, request.requestId, "accepted", input, {
        controlId: control.controlId,
      });
    }
    return;
  }
  recordTerminal(eventsFile, request.requestId, "failed", input, {
    controlId: control.controlId,
    reason: "authority-control-unavailable",
  });
};

const processPendingHumanDecision = async (
  eventsFile: string,
  request: HumanDecisionIntakeRequest,
  input: InteractionActionAuthorityInput
): Promise<void> => {
  const journalFile = input.journalFile;
  if (!(journalFile && regularFile(journalFile))) {
    recordDecisionDenial(
      eventsFile,
      request,
      input,
      "authority-journal-unavailable"
    );
    return;
  }
  let control: GovernessControlRecord | undefined;
  try {
    control = decisionControl(request, journalFile);
  } catch {
    recordDecisionDenial(
      eventsFile,
      request,
      input,
      "authority-journal-unavailable"
    );
    return;
  }
  const resolution = decisionResolutionState(request, input.runDir);
  if (resolution === "matching") {
    processResolvedDecision(eventsFile, request, input, control);
    return;
  }
  if (resolution !== "open") {
    recordDecisionDenial(
      eventsFile,
      request,
      input,
      resolution === "conflict"
        ? "decision-resolution-conflict"
        : "decision-resolution-unavailable"
    );
    return;
  }
  await processOpenDecisionControl(
    eventsFile,
    request,
    input,
    journalFile,
    control
  );
};

const processPendingAcknowledgement = async (
  eventsFile: string,
  request: InteractionActionIntakeRequest,
  input: InteractionActionAuthorityInput
): Promise<void> => {
  const denied = acknowledgementDenialReason(request, input);
  if (denied) {
    recordTerminal(eventsFile, request.requestId, "denied", input, {
      reason: denied,
    });
    return;
  }
  const journalFile = input.journalFile;
  if (!journalFile) {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      reason: "authority-journal-unavailable",
    });
    return;
  }
  const policyContext = { fenceCurrent: true, targetSafe: true } as const;
  const prepared = prepareGovernessControl(journalFile, {
    action: "send-control",
    agent: request.agent,
    at: new Date(input.now()).toISOString(),
    epoch: input.epoch,
    idempotencyKey: `interaction/v1:${request.interactionId}:${request.actionId}`,
    payload: ACKNOWLEDGEMENT,
    policyClass: "safe-automatic",
    policyContext,
  });
  if (!preparedMatches(prepared, request, input.epoch)) {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      reason: "authority-journal-collision",
    });
    return;
  }
  if (
    prepared.phase === "accepted" ||
    prepared.phase === "acknowledged" ||
    prepared.phase === "completed"
  ) {
    recordTerminal(eventsFile, request.requestId, "accepted", input, {
      controlId: prepared.controlId,
    });
    return;
  }
  if (prepared.phase !== "prepared" || !input.fenceCurrent()) {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      reason: "authority-control-unavailable",
    });
    return;
  }
  await dispatchPreparedAcknowledgement(
    eventsFile,
    request,
    input,
    journalFile,
    prepared
  );
};

/**
 * Consume one teardown request inside the run it names.
 *
 * The addressing check is the load-bearing line. This processor runs inside
 * one run's Governess, against one run's journal, and it refuses any record
 * whose `repoId`/`runId` are not this exact run. A teardown therefore cannot
 * reach a sibling run even if one were somehow written into the wrong journal:
 * there is no pattern, no prefix and no repository-derived set anywhere on
 * this path.
 *
 * The terminal event is written BEFORE the teardown runs. `stopGovernessLoop`
 * kills the tmux session this very process lives in, so an accepted event
 * appended afterwards would frequently never be written and the request would
 * look pending forever on a run that is gone. Ordering it first makes the
 * journal honest about what was decided; the executor logs its own outcome.
 */
const processPendingLifecycleTeardown = (
  eventsFile: string,
  request: LifecycleTeardownIntakeRequest,
  input: InteractionActionAuthorityInput
): void => {
  if (!(request.repoId === input.repoId && request.runId === input.runId)) {
    recordTerminal(eventsFile, request.requestId, "denied", input, {
      reason: "lifecycle-run-mismatch",
    });
    return;
  }
  const teardown = input.teardown;
  if (!teardown) {
    recordTerminal(eventsFile, request.requestId, "failed", input, {
      reason: "lifecycle-teardown-unavailable",
    });
    return;
  }
  // A stale fence leaves the request PENDING rather than consuming it, so the
  // next cycle tries again once this Governess is authoritative.
  if (!input.fenceCurrent()) {
    return;
  }
  recordTerminal(eventsFile, request.requestId, "accepted", input);
  teardown(request.reason);
};

const processPendingSnapshot = async (
  eventsFile: string,
  request: IntakeRequest,
  input: InteractionActionAuthorityInput
): Promise<void> => {
  if (isLifecycleTeardown(request)) {
    processPendingLifecycleTeardown(eventsFile, request, input);
    return;
  }
  if (isHumanDecisionRequest(request)) {
    await processPendingHumanDecision(eventsFile, request, input);
    return;
  }
  await processPendingAcknowledgement(eventsFile, request, input);
};

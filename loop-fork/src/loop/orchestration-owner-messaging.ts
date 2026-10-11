import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * RA2: how a supervisor may reach the owner.
 *
 * - A supervisor messages the owner only as a reply to one specific owner
 *   message: one the owner sent to that supervisor, that the server durably
 *   accepted, and that still awaits a reply. The reply names it by message
 *   id (`inReplyTo`); everything else about it is resolved here, from the
 *   server's own durable ledger, never from the caller.
 * - Each owner message allows a bounded number of replies within a window
 *   after the server accepted it (default: one reply, 24 h). After that the
 *   owner-reply-only refusal applies.
 * - Workers and operators never message the owner; they get the same named
 *   refusal.
 * - An unprompted owner notification is an attention-os interaction,
 *   delivered with ntfy; never a raw A2A or supervisor message. The refusal
 *   names that path so the caller can switch to it.
 */

export const OWNER_REPLY_ONLY = "owner-reply-only";
export const OWNER_NOTIFICATION_PATH = "attention-os:interactions";
export const OWNER_REPLY_ONLY_MESSAGE = `Only a supervisor messages the owner, and only as a reply to a specific owner message sent to it that still awaits a reply (name it by message id in inReplyTo; each owner message allows a bounded number of replies within a window). Send an unprompted owner notification as an attention-os interaction (${OWNER_NOTIFICATION_PATH}, delivered with ntfy), never as an A2A or supervisor message.`;

/** The A2A message metadata key a reply names its owner message in. */
export const IN_REPLY_TO_METADATA_KEY = "harness.dev/inReplyTo";

/** The 403 body every surface answers an unprompted owner message with. */
export const ownerReplyOnlyResponse = (): Response =>
  Response.json(
    {
      error: {
        code: OWNER_REPLY_ONLY,
        message: OWNER_REPLY_ONLY_MESSAGE,
        notifyVia: OWNER_NOTIFICATION_PATH,
      },
    },
    { headers: { "cache-control": "no-store" }, status: 403 }
  );

/**
 * The message plane a reply travels on. Each plane names its messages in
 * its own namespace (V1: a global dedupe key; A2A V2: a message id scoped
 * to the sender), so a reply's identity is only meaningful with its plane.
 */
export type OwnerReplyPlane = "a2a" | "v1";

export interface OwnerReplyQuery {
  /** The owner message the reply answers (its message id). */
  inReplyTo: string;
  owner: string;
  /** The plane `replyKey` names a message on. */
  plane: OwnerReplyPlane;
  /** The supervisor that would reply. */
  replier: string;
  /**
   * The reply's own durable identity on its plane (V1: its dedupe key; A2A:
   * its message id, which the V2 dedupe key derives from). A retry of the
   * same reply on the same plane takes no second allowance; the same key on
   * the other plane is another message and does.
   */
  replyKey: string;
}

export interface OwnerReplyAuthority {
  /** Whether `takeReply` would succeed now. No side effect. */
  replyAvailable(query: OwnerReplyQuery): boolean;
  /**
   * Takes one reply from the owner message's allowance, durably, before the
   * reply is accepted; false when none is left (or the take could not be
   * made durable). Idempotent per `replyKey`.
   */
  takeReply(query: OwnerReplyQuery): boolean;
}

export const OWNER_REPLY_DEFAULT_MAX_REPLIES = 1;
export const OWNER_REPLY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OWNER_REPLY_MAX_ENTRIES = 4096;
export const OWNER_REPLY_LEDGER_FILE = "owner-replies.json";
const LEDGER_SCHEMA = "loop-owner-replies.v1";

export interface OwnerReplyPolicy {
  maxReplies: number;
  windowMs: number;
}

interface OwnerMessageEntry {
  /** Server clock (ms) when the owner's message was durably accepted. */
  acceptedAt: number;
  messageId: string;
  owner: string;
  recipient: string;
  /** The plane-qualified reply keys that took an allowance, oldest first. */
  replies: string[];
}

export interface OwnerMessageAccepted {
  messageId: string;
  owner: string;
  recipient: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

const OWNER_REPLY_PLANES: readonly string[] = ["a2a", "v1"];

/**
 * The plane-qualified reply identity the ledger stores and matches, or
 * undefined when the query names no plane or no reply (or one too long for
 * the ledger file to read back).
 */
const qualifiedReplyKey = (query: OwnerReplyQuery): string | undefined => {
  if (
    !(
      OWNER_REPLY_PLANES.includes(query.plane) &&
      typeof query.replyKey === "string" &&
      query.replyKey.length > 0
    )
  ) {
    return undefined;
  }
  const qualified = `${query.plane}:${query.replyKey}`;
  return isNonEmptyString(qualified) ? qualified : undefined;
};

const parseEntry = (value: unknown): OwnerMessageEntry => {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join(",") ===
        "acceptedAt,messageId,owner,recipient,replies" &&
      Number.isSafeInteger(value.acceptedAt) &&
      isNonEmptyString(value.messageId) &&
      isNonEmptyString(value.owner) &&
      isNonEmptyString(value.recipient) &&
      Array.isArray(value.replies) &&
      value.replies.every(isNonEmptyString)
    )
  ) {
    throw new Error("owner reply ledger entry is invalid");
  }
  return {
    acceptedAt: Number(value.acceptedAt),
    messageId: value.messageId,
    owner: value.owner,
    recipient: value.recipient,
    replies: [...(value.replies as string[])],
  };
};

const entryKey = (owner: string, recipient: string, messageId: string) =>
  JSON.stringify([owner, recipient, messageId]);

/**
 * The durable record of owner messages awaiting a reply: a 0600 JSON file
 * under the server's stateDir, rewritten atomically (temp file, fsync,
 * rename). Only an owner message the server durably accepted is recorded
 * (`recordOwnerMessage`, called after acceptance, never by an ingress gate),
 * so no supervisor can grow or steer it.
 *
 * Fail closed: a ledger file that is not a regular 0600 file of this user,
 * or that does not parse, marks the ledger broken. A broken ledger allows
 * no reply, records nothing and never overwrites the file (the evidence is
 * kept for the operator). A write that fails is rolled back in memory.
 */
export class OwnerReplyLedger implements OwnerReplyAuthority {
  readonly #entries = new Map<string, OwnerMessageEntry>();
  readonly #file: string;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #policy: OwnerReplyPolicy;
  #broken: string | undefined;

  constructor(options: {
    file: string;
    maxEntries?: number;
    now?: () => number;
    policy?: Partial<OwnerReplyPolicy>;
  }) {
    this.#file = options.file;
    this.#maxEntries = options.maxEntries ?? OWNER_REPLY_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#policy = {
      maxReplies: options.policy?.maxReplies ?? OWNER_REPLY_DEFAULT_MAX_REPLIES,
      windowMs: options.policy?.windowMs ?? OWNER_REPLY_DEFAULT_WINDOW_MS,
    };
    this.#load();
  }

  /** Why the ledger refuses everything, or undefined when it is usable. */
  get broken(): string | undefined {
    return this.#broken;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Records an owner message the server durably accepted. A resend of the
   * same message (same owner, recipient and id) neither renews its window
   * nor restores its allowance. False when nothing was recorded durably.
   */
  recordOwnerMessage(input: OwnerMessageAccepted): boolean {
    if (this.#broken) {
      return false;
    }
    const key = entryKey(input.owner, input.recipient, input.messageId);
    if (this.#entries.has(key)) {
      return true;
    }
    const before = this.#snapshot();
    this.#prune();
    this.#entries.set(key, {
      acceptedAt: this.#now(),
      messageId: input.messageId,
      owner: input.owner,
      recipient: input.recipient,
      replies: [],
    });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) {
        break;
      }
      this.#entries.delete(oldest);
    }
    return this.#commit(before);
  }

  replyAvailable(query: OwnerReplyQuery): boolean {
    const entry = this.#live(query);
    const replyKey = qualifiedReplyKey(query);
    return (
      entry !== undefined &&
      replyKey !== undefined &&
      (entry.replies.includes(replyKey) ||
        entry.replies.length < this.#policy.maxReplies)
    );
  }

  takeReply(query: OwnerReplyQuery): boolean {
    const entry = this.#live(query);
    const replyKey = qualifiedReplyKey(query);
    if (!(entry && replyKey)) {
      return false;
    }
    if (entry.replies.includes(replyKey)) {
      return true;
    }
    if (entry.replies.length >= this.#policy.maxReplies) {
      return false;
    }
    const before = this.#snapshot();
    entry.replies.push(replyKey);
    return this.#commit(before);
  }

  /** The owner message the query names, if it may still be replied to. */
  #live(query: OwnerReplyQuery): OwnerMessageEntry | undefined {
    // A broken ledger holds no entries (#load clears them), so it answers no.
    const entry = this.#entries.get(
      entryKey(query.owner, query.replier, query.inReplyTo)
    );
    if (!entry || this.#now() - entry.acceptedAt >= this.#policy.windowMs) {
      return undefined;
    }
    return entry;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (now - entry.acceptedAt >= this.#policy.windowMs) {
        this.#entries.delete(key);
      }
    }
  }

  #snapshot(): [string, OwnerMessageEntry][] {
    return [...this.#entries].map(([key, entry]) => [
      key,
      { ...entry, replies: [...entry.replies] },
    ]);
  }

  #commit(before: [string, OwnerMessageEntry][]): boolean {
    try {
      this.#write();
      return true;
    } catch {
      this.#entries.clear();
      for (const [key, entry] of before) {
        this.#entries.set(key, entry);
      }
      return false;
    }
  }

  #load(): void {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(this.#file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.#broken = "owner reply ledger is unreadable";
      return;
    }
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      // biome-ignore lint/suspicious/noBitwiseOperators: mode bits.
      (Number(stat.mode) & 0o077) !== 0 ||
      (uid !== undefined && Number(stat.uid) !== uid)
    ) {
      this.#broken =
        "owner reply ledger must be a regular 0600 file owned by this user";
      return;
    }
    try {
      const value: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
      if (
        !(
          isRecord(value) &&
          Object.keys(value).sort().join(",") === "entries,schema" &&
          value.schema === LEDGER_SCHEMA &&
          Array.isArray(value.entries)
        )
      ) {
        throw new Error("owner reply ledger is invalid");
      }
      for (const raw of value.entries) {
        const entry = parseEntry(raw);
        this.#entries.set(
          entryKey(entry.owner, entry.recipient, entry.messageId),
          entry
        );
      }
    } catch {
      this.#entries.clear();
      this.#broken = "owner reply ledger is invalid";
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { mode: 0o700, recursive: true });
    const body = `${JSON.stringify({
      entries: [...this.#entries.values()],
      schema: LEDGER_SCHEMA,
    })}\n`;
    const temp = `${this.#file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.#file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

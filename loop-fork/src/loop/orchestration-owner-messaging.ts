import type { SupervisorThreadBoardProjection } from "./supervisor-thread-store";

/**
 * RA2: how a supervisor may reach the owner.
 *
 * - A supervisor messages the owner only as a reply on a thread the owner
 *   started (the owner's message to that supervisor opened it).
 * - An unprompted owner notification is an attention-os interaction,
 *   delivered with ntfy; never a raw A2A or supervisor message. The refusal
 *   names that path so the caller can switch to it.
 *
 * Where "started" is read from: on V1 the durable thread board (accepted
 * messages only); on the A2A plane the context ids the owner opened with
 * that supervisor through this server (`OwnerContextRegistry`).
 */

export const OWNER_REPLY_ONLY = "owner-reply-only";
export const OWNER_NOTIFICATION_PATH = "attention-os:interactions";
export const OWNER_REPLY_ONLY_MESSAGE = `A supervisor messages the owner only as a reply on a thread the owner started. Send an unprompted owner notification as an attention-os interaction (${OWNER_NOTIFICATION_PATH}, delivered with ntfy), never as an A2A or supervisor message.`;

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

export interface OwnerThreadQuery {
  owner: string;
  /** The supervisor that would reply. */
  replier: string;
  threadId: string;
}

export interface OwnerThreadIndex {
  /** Whether `owner` started `threadId` and messaged `replier` on it. */
  ownerStarted(query: OwnerThreadQuery): boolean;
}

/**
 * V1: the thread board holds accepted messages only. The thread's earliest
 * message must be the owner's, and the owner must have messaged the replier
 * on it. An unreadable board answers no (fail closed).
 */
export const ownerThreadsFromBoard = (
  read: () => SupervisorThreadBoardProjection
): OwnerThreadIndex => ({
  ownerStarted({ owner, replier, threadId }) {
    let board: SupervisorThreadBoardProjection;
    try {
      board = read();
    } catch {
      return false;
    }
    const thread = board.threads.find((entry) => entry.threadId === threadId);
    return (
      thread?.messages[0]?.item.from === owner &&
      thread.messages.some(
        ({ item }) => item.from === owner && item.to === replier
      )
    );
  },
});

export const OWNER_CONTEXT_MAX_ENTRIES = 4096;
export const OWNER_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The A2A plane: the context ids the owner opened with each supervisor, in
 * this server's memory. Bounded by count (the oldest is evicted) and age.
 * Only an owner send records, so no supervisor can grow or steer it. A
 * restart forgets it: a reply on an older context is then refused (fail
 * closed) and the refusal names the attention-os path.
 */
export class OwnerContextRegistry implements OwnerThreadIndex {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(
    options: { maxEntries?: number; now?: () => number; ttlMs?: number } = {}
  ) {
    this.#maxEntries = options.maxEntries ?? OWNER_CONTEXT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? OWNER_CONTEXT_TTL_MS;
  }

  get size(): number {
    return this.#entries.size;
  }

  record(input: { owner: string; recipient: string; threadId: string }): void {
    const key = contextKey(input.owner, input.recipient, input.threadId);
    // A later owner send on the same context renews it as the newest.
    this.#entries.delete(key);
    this.#entries.set(key, this.#now());
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  ownerStarted({ owner, replier, threadId }: OwnerThreadQuery): boolean {
    const key = contextKey(owner, replier, threadId);
    const recordedAt = this.#entries.get(key);
    if (recordedAt === undefined) {
      return false;
    }
    if (this.#now() - recordedAt >= this.#ttlMs) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }
}

const contextKey = (owner: string, recipient: string, threadId: string) =>
  JSON.stringify([owner, recipient, threadId]);

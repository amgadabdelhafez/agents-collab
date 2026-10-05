import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MailboxEnvelope } from "./supervisor-mailbox-delivery";

/**
 * NOT WIRED INTO THE SERVICE YET: these are the receive, acknowledge and status
 * primitives, with no production caller. Integrating them into the
 * orchestration receive and status paths is a separate change, and until then
 * this module claims no operational behaviour.
 *
 * A recipient's durable read position, kept apart from whether its watcher is
 * alive. Run 36 (2026-09-19) is the case this exists for: a renewed event
 * watcher reported a previous event as current while a request delivered at
 * 22:18:25.482Z sat unread until 22:22:48.994Z. An armed watcher says nothing
 * about what was consumed, so liveness and progress are reported separately and
 * status is computed from the cursor, never from the watcher.
 */
export interface MailboxCursor {
  consumedAt: null | string;
  consumedIdempotencyKeys: string[];
  schema: "supervisor-mailbox-cursor.v1";
}

export type RecipientStatus = "blocked" | "current" | "unavailable" | "unread";

export type MailboxReadOutcome =
  | { entries: MailboxEnvelope[]; invalid: number; kind: "read" }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

const isEnvelope = (value: unknown): value is MailboxEnvelope => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.idempotencyKey === "string" &&
    record.idempotencyKey.length > 0 &&
    typeof record.at === "string" &&
    Number.isFinite(Date.parse(record.at)) &&
    typeof record.body === "string" &&
    typeof record.messageId === "string" &&
    typeof record.target === "string" &&
    typeof record.workflowId === "string"
  );
};

export interface MailboxStatus {
  // Progress, from the cursor alone.
  consumedAt: null | string;
  // Records that parsed but were not envelopes: reported, never hidden.
  invalid: number;
  oldestUnreadAt: null | string;
  queueAgeMs: null | number;
  status: RecipientStatus;
  unavailableReason?: string;
  unread: number;
  // Freshness of the wake mechanism, which is NOT progress.
  watcherArmedAt: null | string;
  watcherFresh: boolean;
}

const JSONL_SUFFIX_RE = /\.jsonl$/u;

/**
 * One definition of where a recipient's cursor lives. The reader that writes it
 * and the reconciler that reads it must agree, or an acknowledgment recorded by
 * one is invisible to the other.
 */
export const mailboxCursorPathFor = (mailboxPath: string): string =>
  `${mailboxPath.replace(JSONL_SUFFIX_RE, "")}.cursor.json`;

export const emptyCursor = (): MailboxCursor => ({
  consumedAt: null,
  consumedIdempotencyKeys: [],
  schema: "supervisor-mailbox-cursor.v1",
});

export const readMailboxCursor = (path: string): MailboxCursor => {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<MailboxCursor>;
    if (parsed.schema !== "supervisor-mailbox-cursor.v1") {
      return emptyCursor();
    }
    return {
      consumedAt:
        typeof parsed.consumedAt === "string" ? parsed.consumedAt : null,
      consumedIdempotencyKeys: Array.isArray(parsed.consumedIdempotencyKeys)
        ? parsed.consumedIdempotencyKeys.filter(
            (key): key is string => typeof key === "string"
          )
        : [],
      schema: "supervisor-mailbox-cursor.v1",
    };
  } catch {
    return emptyCursor();
  }
};

/**
 * Published by rename, so a reader sees either the previous cursor or the new
 * one, never a half-written file: a crash mid-write leaves the old position,
 * which at most replays already-consumed messages, and consuming is idempotent.
 * Concurrent readers of ONE mailbox are not supported (last writer wins), so a
 * recipient must have a single reader.
 */
export const writeMailboxCursor = (
  path: string,
  cursor: MailboxCursor
): void => {
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.cursor`);
  writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
};

/**
 * A mailbox never written is "absent" (nothing is owed). One that cannot be
 * read (permissions, I/O, a directory in its place) is "unavailable": silence
 * there is not evidence of an empty queue and must never read as current.
 * Records that parse but are not envelopes are counted invalid and skipped,
 * and valid records after them are still processed.
 */
export const readMailbox = (path: string): MailboxReadOutcome => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "unavailable",
      reason: code ?? (error instanceof Error ? error.message : "read failed"),
    };
  }
  const entries: MailboxEnvelope[] = [];
  let invalid = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    if (isEnvelope(parsed)) {
      entries.push(parsed);
    } else {
      invalid += 1;
    }
  }
  return { entries, invalid, kind: "read" };
};

/**
 * Status of one recipient. "current" requires that every delivered message has
 * been consumed; an armed watcher alone can never produce it, and an expired
 * watcher with unread mail reads "blocked" rather than "unread", because
 * nothing will arrive to prompt the read.
 */
export const mailboxStatus = (input: {
  cursor: MailboxCursor;
  mailbox: MailboxReadOutcome;
  now: string;
  watcherArmedAt?: null | string;
  watcherTtlMs?: number;
}): MailboxStatus => {
  if (input.mailbox.kind === "unavailable") {
    // Unreadable is not empty: reporting "current" here is exactly how a
    // broken recipient would look healthy.
    return {
      consumedAt: input.cursor.consumedAt,
      invalid: 0,
      oldestUnreadAt: null,
      queueAgeMs: null,
      status: "unavailable",
      unavailableReason: input.mailbox.reason,
      unread: 0,
      watcherArmedAt: input.watcherArmedAt ?? null,
      watcherFresh: false,
    };
  }
  const entries = input.mailbox.kind === "read" ? input.mailbox.entries : [];
  const invalid = input.mailbox.kind === "read" ? input.mailbox.invalid : 0;
  const consumed = new Set(input.cursor.consumedIdempotencyKeys);
  const unread = entries.filter((entry) => !consumed.has(entry.idempotencyKey));
  const oldestUnreadAt = unread.reduce<null | string>(
    (oldest, entry) =>
      oldest === null || entry.at < oldest ? entry.at : oldest,
    null
  );
  const nowMs = Date.parse(input.now);
  const armed = input.watcherArmedAt ?? null;
  const watcherFresh =
    armed !== null &&
    Number.isFinite(Date.parse(armed)) &&
    nowMs - Date.parse(armed) <= (input.watcherTtlMs ?? 0);
  let status: RecipientStatus = "current";
  if (unread.length > 0) {
    status = watcherFresh ? "unread" : "blocked";
  }
  return {
    consumedAt: input.cursor.consumedAt,
    invalid,
    oldestUnreadAt,
    queueAgeMs:
      oldestUnreadAt === null ? null : nowMs - Date.parse(oldestUnreadAt),
    status,
    unread: unread.length,
    watcherArmedAt: armed,
    watcherFresh,
  };
};

/** Consuming is idempotent: replaying the same messages advances nothing new. */
export const consumeMailbox = (input: {
  at: string;
  cursor: MailboxCursor;
  mailbox: MailboxReadOutcome;
}): { consumed: MailboxEnvelope[]; cursor: MailboxCursor } => {
  if (input.mailbox.kind !== "read") {
    // Nothing may be marked consumed from a mailbox that was not read.
    return { consumed: [], cursor: input.cursor };
  }
  const seen = new Set(input.cursor.consumedIdempotencyKeys);
  const fresh = input.mailbox.entries.filter(
    (entry) => !seen.has(entry.idempotencyKey)
  );
  if (fresh.length === 0) {
    return { consumed: [], cursor: input.cursor };
  }
  return {
    consumed: fresh,
    cursor: {
      consumedAt: input.at,
      consumedIdempotencyKeys: [
        ...input.cursor.consumedIdempotencyKeys,
        ...fresh.map((entry) => entry.idempotencyKey),
      ],
      schema: "supervisor-mailbox-cursor.v1",
    },
  };
};

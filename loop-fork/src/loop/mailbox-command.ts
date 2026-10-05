import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  consumeMailbox,
  type MailboxStatus,
  mailboxCursorPathFor,
  mailboxStatus,
  readMailbox,
  readMailboxCursor,
  writeMailboxCursor,
} from "./supervisor-mailbox-cursor";
import { mailboxPathFor } from "./supervisor-mailbox-delivery";

/**
 * The receive, acknowledge and status path for a session that no Loop pane can
 * wake. This is POLLING-ONLY: a message counts as delivered when this command
 * reads it and acknowledged when the reader records that, never because it was
 * written to the file.
 *
 *   loop mailbox status  --id supervisor:x --root <dir> [--watcher-armed-at T] [--watcher-ttl-ms N]
 *   loop mailbox receive --id supervisor:x --root <dir>   # prints unread + a receipt
 *   loop mailbox ack     --id supervisor:x --root <dir> --key <k> [--key <k>...] [--receipt <r>]
 *   loop mailbox send    --id supervisor:me --to supervisor:x --root <dir>
 *                        --message-id <id> --body-file <path> [--thread <id>]
 *
 * An ack names the keys the reader actually handled, so a message delivered
 * between the receive and the ack stays unread instead of being consumed
 * unseen. --receipt (as printed by receive) additionally pins the exact set.
 */
export const MAILBOX_COMMAND = "mailbox";
const SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/u;
const DEFAULT_WATCHER_TTL_MS = 30 * 60_000;
const ACTIONS = ["ack", "receive", "send", "status"] as const;
type MailboxAction = (typeof ACTIONS)[number];

export interface MailboxCommandResult {
  action: "ack" | "receive" | "send" | "status";
  consumed?: number;
  consumedKeys?: string[];
  cursorPath: string;
  // send only: what was written, so a caller can acknowledge or find it later.
  delivered?: { idempotencyKey: string; target: string; workflowId: string };
  mailboxPath: string;
  messages?: unknown[];
  // Identifies the exact set a receive returned; an ack may verify against it.
  receipt?: string;
  status: MailboxStatus;
}

// A receipt is a function of the recipient and the exact key set, so a partial
// or padded ack cannot pass as the set that was received. It is a
// set-consistency check and NOTHING MORE: it does not authenticate a reader and
// it is not evidence that a receive ever happened, since anyone who can name the
// keys can compute it.
export const receiptFor = (supervisorId: string, keys: string[]): string =>
  createHash("sha256")
    .update(`${supervisorId}\n${[...keys].sort().join("\n")}`, "utf8")
    .digest("hex")
    .slice(0, 32);

const flag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
};

export const flags = (argv: string[], name: string): string[] => {
  const values: string[] = [];
  for (const [index, arg] of argv.entries()) {
    const value = arg === name ? argv[index + 1] : undefined;
    if (value && !value.startsWith("--")) {
      values.push(value);
    }
  }
  return values;
};

const cursorPathFor = (root: string, supervisorId: string): string =>
  mailboxCursorPathFor(mailboxPathFor(root, supervisorId));

/**
 * A peer note between two sessions, not a service delivery. Its workflow id is
 * deliberately `peer-message:<id>`, which no workflow uses, so a peer note
 * matches no board item and the consumption reconciler advances nothing for it.
 *
 * That is a separate namespace, NOT a control: anyone who can write a mailbox
 * file can write any envelope they like, and nothing here would stop or detect
 * it. The guarantee holds only under the same trusted-local-writer assumption
 * as the rest of this transport.
 *
 * A note's logical identity is its sender AND its message id — the recipient is
 * implied by whose mailbox it lands in. Keying on the message id alone silently
 * dropped a second sender's note as a duplicate (found in review, 2026-09-20).
 */
const PEER_WORKFLOW_PREFIX = "peer-message:";
const MESSAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const sendPeerMessage = (
  rest: string[],
  supervisorId: string,
  root: string,
  at: string
): MailboxCommandResult["delivered"] => {
  const target = flag(rest, "--to") ?? "";
  const messageId = flag(rest, "--message-id") ?? "";
  const bodyFile = flag(rest, "--body-file");
  if (!SUPERVISOR_ID_RE.test(target)) {
    throw new Error("Invalid --to: expected supervisor:<name>");
  }
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new Error("Invalid --message-id: expected a short slug");
  }
  if (!bodyFile) {
    // A file, not an argument: a body on the command line would land in the
    // process list and in shell history.
    throw new Error("send requires --body-file <path>");
  }
  const body = readFileSync(bodyFile, "utf8");
  if (!body.trim()) {
    throw new Error(`--body-file ${bodyFile} is empty`);
  }
  const envelope = {
    artifactRefs: flags(rest, "--artifact"),
    at,
    body,
    delivery: "mailbox" as const,
    from: supervisorId,
    idempotencyKey: `${supervisorId}:${messageId}:peer:1`,
    messageId,
    target,
    threadId: flag(rest, "--thread") ?? messageId,
    workflowId: `${PEER_WORKFLOW_PREFIX}${messageId}`,
  };
  const mailbox = mailboxPathFor(root, target);
  const existing = readMailbox(mailbox);
  if (existing.kind === "unavailable") {
    throw new Error(
      `send refused: ${mailbox} is unavailable (${existing.reason})`
    );
  }
  const prior =
    existing.kind === "read"
      ? existing.entries.find(
          (entry) => entry.idempotencyKey === envelope.idempotencyKey
        )
      : undefined;
  if (prior) {
    // An exact replay is the same message. A changed payload under the same
    // logical id is a different message wearing its name, and reporting it as
    // sent would lose it silently.
    const same =
      prior.body === envelope.body &&
      prior.threadId === envelope.threadId &&
      JSON.stringify(prior.artifactRefs ?? []) ===
        JSON.stringify(envelope.artifactRefs);
    if (!same) {
      throw new Error(
        `send refused: ${messageId} was already sent to ${target} with different content; use a new --message-id`
      );
    }
    return {
      idempotencyKey: envelope.idempotencyKey,
      target,
      workflowId: envelope.workflowId,
    };
  }
  mkdirSync(root, { mode: 0o700, recursive: true });
  appendFileSync(mailbox, `${JSON.stringify(envelope)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    idempotencyKey: envelope.idempotencyKey,
    target,
    workflowId: envelope.workflowId,
  };
};

export const runMailboxCommand = (
  argv: string[],
  now: () => string = () => new Date().toISOString()
): MailboxCommandResult => {
  const [, requested = "status", ...rest] = argv;
  const action = requested as MailboxAction;
  if (!ACTIONS.includes(action)) {
    throw new Error(
      [
        `Usage: loop ${MAILBOX_COMMAND} <${ACTIONS.join("|")}|sweep> --id <supervisor:id> --root <dir>`,
        "  receive  print unread mail; it does not acknowledge anything",
        "  ack      --key <idempotencyKey> (repeatable), the exact keys you handled",
        "  send     --to <supervisor:id> --message-id <slug> --body-file <path>",
        "  status   one recipient; sweep   every recipient under --root",
      ].join("\n")
    );
  }
  const supervisorId = flag(rest, "--id") ?? "";
  const root = flag(rest, "--root") ?? "";
  if (!SUPERVISOR_ID_RE.test(supervisorId)) {
    throw new Error("Invalid --id: expected supervisor:<name>");
  }
  if (!(root && isAbsolute(root) && resolve(root) === root)) {
    throw new Error("Invalid --root: expected an absolute directory");
  }
  const mailboxPath = mailboxPathFor(root, supervisorId);
  const cursorPath = cursorPathFor(root, supervisorId);
  const at = now();
  const outcome = readMailbox(mailboxPath);
  const cursor = readMailboxCursor(cursorPath);
  const watcherArmedAt = flag(rest, "--watcher-armed-at") ?? null;
  const watcherTtl = Number(
    flag(rest, "--watcher-ttl-ms") ?? DEFAULT_WATCHER_TTL_MS
  );
  const statusOf = (current = cursor): MailboxStatus =>
    mailboxStatus({
      cursor: current,
      mailbox: outcome,
      now: at,
      watcherArmedAt,
      watcherTtlMs: Number.isFinite(watcherTtl)
        ? watcherTtl
        : DEFAULT_WATCHER_TTL_MS,
    });

  if (action === "status") {
    return { action, cursorPath, mailboxPath, status: statusOf() };
  }
  if (action === "send") {
    return {
      action,
      cursorPath,
      delivered: sendPeerMessage(rest, supervisorId, root, at),
      mailboxPath,
      status: statusOf(),
    };
  }
  const consumedKeys = new Set(cursor.consumedIdempotencyKeys);
  const unread =
    outcome.kind === "read"
      ? outcome.entries.filter(
          (entry) => !consumedKeys.has(entry.idempotencyKey)
        )
      : [];
  if (action === "receive") {
    // Reading does not acknowledge: the cursor only moves on ack, so a reader
    // that crashes mid-handling sees the same messages again.
    return {
      action,
      cursorPath,
      mailboxPath,
      messages: unread,
      receipt: receiptFor(
        supervisorId,
        unread.map((entry) => entry.idempotencyKey)
      ),
      status: statusOf(),
    };
  }
  const requestedKeys = flags(rest, "--key");
  if (requestedKeys.length === 0) {
    throw new Error(
      "ack requires the keys it received: --key <idempotencyKey> (repeatable). Run receive first."
    );
  }
  // An unreadable mailbox is not an empty one: refusing here keeps ack from
  // reporting "not in <path>" about a file it could not read.
  if (outcome.kind === "unavailable") {
    throw new Error(
      `ack refused: ${mailboxPath} is unavailable (${outcome.reason}); nothing was acknowledged`
    );
  }
  const present = new Map(
    outcome.kind === "read"
      ? outcome.entries.map((entry) => [entry.idempotencyKey, entry] as const)
      : []
  );
  // An unknown key is a mistake, not a no-op: acknowledging it would claim
  // receipt of something this mailbox never held.
  const unknown = requestedKeys.filter(
    (key) => !(present.has(key) || consumedKeys.has(key))
  );
  if (unknown.length > 0) {
    throw new Error(`ack refused: ${unknown.join(", ")} not in ${mailboxPath}`);
  }
  const expectedReceipt = flag(rest, "--receipt");
  if (
    expectedReceipt &&
    receiptFor(supervisorId, requestedKeys) !== expectedReceipt
  ) {
    throw new Error("ack refused: the keys do not match the receipt");
  }
  // Only the named keys move, so anything that arrived after the receive stays
  // unread rather than being consumed unseen.
  const named = requestedKeys
    .map((key) => present.get(key))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const { consumed, cursor: advanced } = consumeMailbox({
    at,
    cursor,
    mailbox: { entries: named, invalid: 0, kind: "read" },
  });
  if (consumed.length > 0) {
    mkdirSync(join(root), { mode: 0o700, recursive: true });
    writeMailboxCursor(cursorPath, advanced);
  }
  return {
    action,
    consumed: consumed.length,
    consumedKeys: consumed.map((entry) => entry.idempotencyKey),
    cursorPath,
    mailboxPath,
    status: statusOf(advanced),
  };
};

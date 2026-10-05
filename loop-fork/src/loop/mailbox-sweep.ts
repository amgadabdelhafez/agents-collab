import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type MailboxStatus,
  mailboxStatus,
  readMailbox,
  readMailboxCursor,
} from "./supervisor-mailbox-cursor";
import { mailboxPathFor } from "./supervisor-mailbox-delivery";

/**
 * Read-only view of every recipient in one mailbox root:
 *
 *   loop mailbox sweep --root <dir> [--watcher-ttl-ms N]
 *
 * Checking on a peer used to require knowing its id, so a session nobody
 * remembered to ask about could sit blocked indefinitely. This enumerates the
 * root instead, and consumes nothing: a sweep is never an acknowledgment.
 *
 * No watcher is armed for a polled mailbox, so unread here reports "blocked",
 * which is the truth: nothing will wake that recipient until someone polls.
 */
const MAILBOX_FILE_RE = /\.jsonl$/u;
const CURSOR_SUFFIX = ".cursor.json";
const DEFAULT_WATCHER_TTL_MS = 30 * 60_000;

export interface MailboxSweepEntry {
  cursorPath: string;
  mailboxPath: string;
  // null when the file name does not round-trip to a valid recipient id, so a
  // guessed id is never presented as the recipient's own.
  recipient: null | string;
  status: MailboxStatus;
}

export interface MailboxSweepResult {
  action: "sweep";
  blocked: number;
  recipients: MailboxSweepEntry[];
  root: string;
  unreadTotal: number;
}

/**
 * mailboxPathFor replaces ":" with "_", and every valid id starts with
 * "supervisor:", so restoring the FIRST underscore is the only candidate. It is
 * still checked by re-deriving the path: a name that does not round-trip is
 * reported with a null recipient rather than a guess.
 */
const recipientFromFile = (root: string, file: string): null | string => {
  const stem = file.replace(MAILBOX_FILE_RE, "");
  const underscore = stem.indexOf("_");
  if (underscore < 0) {
    return null;
  }
  const candidate = `${stem.slice(0, underscore)}:${stem.slice(underscore + 1)}`;
  return mailboxPathFor(root, candidate) === join(root, file)
    ? candidate
    : null;
};

const byQueueAge = (a: MailboxSweepEntry, b: MailboxSweepEntry): number =>
  (b.status.queueAgeMs ?? -1) - (a.status.queueAgeMs ?? -1);

export const runMailboxSweep = (
  argv: string[],
  now: () => string = () => new Date().toISOString()
): MailboxSweepResult => {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? (argv[rootIndex + 1] ?? "") : "";
  if (!(root && isAbsolute(root) && resolve(root) === root)) {
    throw new Error("Invalid --root: expected an absolute directory");
  }
  const ttlIndex = argv.indexOf("--watcher-ttl-ms");
  const ttl = Number(
    ttlIndex >= 0 ? argv[ttlIndex + 1] : DEFAULT_WATCHER_TTL_MS
  );
  // An unreadable root is not an empty estate: it must not report "all clear".
  const files = readdirSync(root).filter(
    (file) => MAILBOX_FILE_RE.test(file) && !file.endsWith(CURSOR_SUFFIX)
  );
  const at = now();
  const recipients = files
    .map((file): MailboxSweepEntry => {
      const mailboxPath = join(root, file);
      const cursorPath = `${mailboxPath.replace(MAILBOX_FILE_RE, "")}${CURSOR_SUFFIX}`;
      return {
        cursorPath,
        mailboxPath,
        recipient: recipientFromFile(root, file),
        status: mailboxStatus({
          cursor: readMailboxCursor(cursorPath),
          mailbox: readMailbox(mailboxPath),
          now: at,
          watcherArmedAt: null,
          watcherTtlMs: Number.isFinite(ttl) ? ttl : DEFAULT_WATCHER_TTL_MS,
        }),
      };
    })
    .sort(byQueueAge);
  return {
    action: "sweep",
    blocked: recipients.filter((entry) => entry.status.status === "blocked")
      .length,
    recipients,
    root,
    unreadTotal: recipients.reduce(
      (sum, entry) => sum + entry.status.unread,
      0
    ),
  };
};

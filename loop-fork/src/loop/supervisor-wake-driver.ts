import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { MailboxFileAccess } from "./mailbox-file-access";
import {
  type MailboxCursor,
  type MailboxReadOutcome,
  type MailboxStatus,
  mailboxCursorPathFor,
  mailboxStatus,
} from "./supervisor-mailbox-cursor";

/**
 * Turns "this recipient has mail nobody is reading" into one wake.
 *
 * Mailbox delivery is durable but polling-only, so an unread entry sits at
 * `blocked` until its recipient happens to look. A wake is a TRIGGER and
 * nothing else: it never writes a cursor, never claims or acknowledges, and
 * never advances a workflow. Acknowledgment stays the recipient's own act,
 * which is the whole point of the explicit-key ack.
 *
 * It adds no state store. The decision is read from the mailbox and cursor that
 * already exist, and the only thing held here is in-process memory of what this
 * driver has already woken, so a restart re-wakes at most once more.
 */
export type WakeOutcome = "busy" | "failed" | "woken";

export interface WakeRequest {
  // The directory the recipient passes as --root: what makes the notice's
  // receive command runnable rather than generic.
  mailboxRoot: string;
  oldestUnreadAt: string;
  recipient: string;
  sessionName: string;
  unread: number;
  // The oldest unread key: what the notice points the recipient at first.
  unreadKey: string;
  /**
   * Identity of the whole unread SET, not just its oldest member. Review found
   * (2026-09-20) that keying on the oldest key alone suppressed a wake when new
   * mail arrived while an older message was still unread — the common case, and
   * exactly the one a wake exists for. Any arrival or acknowledgment changes
   * this, so the contract is: identical unread set inside the window is
   * suppressed, and any change to it is worth a wake.
   */
  unreadSet: string;
}

export interface WakePort {
  wake(request: WakeRequest): Promise<WakeOutcome>;
}

export interface SupervisorWakeTarget {
  mailbox: string;
  recipient: string;
  // The addressable session name, as `ListAgents` prints it.
  sessionName: string;
}

export interface SupervisorWakeDriverOptions {
  /**
   * The bounded, async mailbox reads (one per server, shared with the
   * reconciler and delivery). Default: a private one.
   */
  access?: MailboxFileAccess;
  log?: (line: string) => void;
  // How long to leave a recipient alone after waking it for the same mail. A
  // woken session still has to start, read and acknowledge; waking it again in
  // that window is noise, not urgency.
  minReWakeMs?: number;
  now?: () => string;
  port: WakePort;
  targets: readonly SupervisorWakeTarget[];
}

export interface WakeSweepResult {
  busy: number;
  failed: number;
  // Recipients with nothing unread: current, and correctly left alone.
  quiet: number;
  // Recipients skipped because this driver already woke them for this same
  // mail and the re-wake window has not elapsed.
  suppressed: number;
  /**
   * Recipients whose mailbox could not be READ. Never woken about, because a
   * wake cannot fix a read, but counted separately from `quiet`: an unreadable
   * mailbox is an operational failure and must not hide inside "nothing to do".
   */
  unreadable: string[];
  woken: string[];
}

const DEFAULT_MIN_RE_WAKE_MS = 10 * 60_000;

// Order-independent, so the same unread mail read twice is the same identity.
const setIdentity = (keys: readonly string[]): string =>
  createHash("sha256")
    .update([...keys].sort().join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16);

type WakeTargetRead =
  | { cursor: MailboxCursor; kind: "read"; outcome: MailboxReadOutcome }
  | { kind: "unavailable"; reason: string };

export class SupervisorWakeDriver {
  readonly #access: MailboxFileAccess;
  readonly #log: (line: string) => void;
  /** Recipients whose unreadable mailbox is reported; once per outage. */
  readonly #reportedUnreadable = new Set<string>();
  readonly #minReWakeMs: number;
  readonly #now: () => string;
  readonly #port: WakePort;
  readonly #targets: readonly SupervisorWakeTarget[];
  // recipient -> { key, at }: in-process only, deliberately not persisted.
  readonly #woken = new Map<string, { at: number; key: string }>();

  constructor(options: SupervisorWakeDriverOptions) {
    this.#access = options.access ?? new MailboxFileAccess();
    this.#log = options.log ?? (() => undefined);
    this.#minReWakeMs = options.minReWakeMs ?? DEFAULT_MIN_RE_WAKE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#port = options.port;
    this.#targets = options.targets.map((target) => ({ ...target }));
  }

  async sweep(): Promise<WakeSweepResult> {
    const result: WakeSweepResult = {
      busy: 0,
      failed: 0,
      quiet: 0,
      suppressed: 0,
      unreadable: [],
      woken: [],
    };
    const at = this.#now();
    const nowMs = Date.parse(at);
    // Every target's mailbox and cursor are read at once, each bounded: a
    // parked mailbox (a macOS privacy prompt) costs its own target only.
    const reads = await Promise.all(
      this.#targets.map((target) => this.#read(target))
    );
    for (const [index, target] of this.#targets.entries()) {
      const read = reads[index] as WakeTargetRead;
      if (read.kind === "unavailable") {
        result.unreadable.push(target.recipient);
        if (!this.#reportedUnreadable.has(target.recipient)) {
          this.#reportedUnreadable.add(target.recipient);
          this.#log(
            `[loop] mailbox for ${target.recipient} is unreadable: ${read.reason}`
          );
        }
        continue;
      }
      this.#reportedUnreadable.delete(target.recipient);
      const { cursor, outcome } = read;
      const status: MailboxStatus = mailboxStatus({
        cursor,
        mailbox: outcome,
        now: at,
      });
      if (status.unread === 0) {
        result.quiet += 1;
        continue;
      }
      const unread = this.#unread(cursor, outcome);
      const oldest = unread.find((entry) => entry.at === status.oldestUnreadAt);
      if (!oldest) {
        result.quiet += 1;
        continue;
      }
      const unreadSet = setIdentity(unread.map((e) => e.idempotencyKey));
      const previous = this.#woken.get(target.recipient);
      if (
        previous &&
        previous.key === unreadSet &&
        nowMs - previous.at < this.#minReWakeMs
      ) {
        result.suppressed += 1;
        continue;
      }
      await this.#wake(
        target,
        status,
        { oldestKey: oldest.idempotencyKey, unreadSet },
        nowMs,
        result
      );
    }
    return result;
  }

  /** The mailbox, then its cursor; unavailable when either cannot be read. */
  async #read(target: SupervisorWakeTarget): Promise<WakeTargetRead> {
    const outcome = await this.#access.readMailbox(
      target.recipient,
      target.mailbox
    );
    if (outcome.kind === "unavailable") {
      return outcome;
    }
    const cursor = await this.#access.readCursor(
      target.recipient,
      mailboxCursorPathFor(target.mailbox)
    );
    if (cursor.kind === "unavailable") {
      return cursor;
    }
    return { cursor: cursor.cursor, kind: "read", outcome };
  }

  #unread(
    cursor: MailboxCursor,
    outcome: MailboxReadOutcome
  ): { at: string; idempotencyKey: string }[] {
    if (outcome.kind !== "read") {
      return [];
    }
    const consumed = new Set(cursor.consumedIdempotencyKeys);
    return outcome.entries.filter(
      (entry) => !consumed.has(entry.idempotencyKey)
    );
  }

  async #wake(
    target: SupervisorWakeTarget,
    status: MailboxStatus,
    identity: { oldestKey: string; unreadSet: string },
    nowMs: number,
    result: WakeSweepResult
  ): Promise<void> {
    let outcome: WakeOutcome;
    try {
      outcome = await this.#port.wake({
        mailboxRoot: dirname(target.mailbox),
        oldestUnreadAt: status.oldestUnreadAt as string,
        recipient: target.recipient,
        sessionName: target.sessionName,
        unread: status.unread,
        unreadKey: identity.oldestKey,
        unreadSet: identity.unreadSet,
      });
    } catch (error) {
      result.failed += 1;
      this.#log(
        `[loop] wake failed for ${target.recipient}: ${error instanceof Error ? error.message : "unknown error"}`
      );
      return;
    }
    if (outcome === "woken") {
      // Recorded only on a wake that actually happened, so a busy or failed
      // recipient is retried on the next sweep rather than suppressed.
      this.#woken.set(target.recipient, {
        at: nowMs,
        key: identity.unreadSet,
      });
      result.woken.push(target.recipient);
      return;
    }
    if (outcome === "busy") {
      result.busy += 1;
      return;
    }
    result.failed += 1;
  }
}

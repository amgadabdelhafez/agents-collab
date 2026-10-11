import { MailboxFileAccess } from "./mailbox-file-access";
import type { SupervisorBridgeConsumptionRuntime } from "./supervisor-bridge-consumption";
import {
  type MailboxCursor,
  type MailboxReadOutcome,
  mailboxCursorPathFor,
} from "./supervisor-mailbox-cursor";
import type { MailboxEnvelope } from "./supervisor-mailbox-delivery";
import type { SupervisorMessageBoardItem } from "./supervisor-message-read-model";
import { ReconcilePassBoard } from "./supervisor-reconcile-board";

/**
 * Carries a mailbox recipient's own acknowledgment back into the workflow.
 *
 * Review finding (2026-09-19): `loop mailbox ack` advances the reader's cursor
 * and nothing else, while the only component that reported consumption to the
 * workflow — the bridge reconciler — skips every recipient whose directory
 * route is undefined, which is exactly what a mailbox-only recipient is. So a
 * message could be received and durably acknowledged by its recipient while the
 * workflow still believed it undelivered, and the deadline driver could escalate
 * work that was already handled.
 *
 * A mailbox cursor reading "current" is NOT the same fact as a workflow reading
 * "acknowledged". This is what translates the first into the second, and only
 * for messages whose envelope proves the claim: the key must be recorded in the
 * recipient's persisted cursor, and the envelope carrying it must be in that
 * recipient's registered mailbox and addressed to that recipient.
 */
const WORKFLOW_ID_RE = /^supervisor-message:[a-f0-9]{64}$/u;

/**
 * The delivery factory issues `${workflowId}:delivery:${attempt}`
 * (supervisor-message-workflow.ts), so a key that does not name its own
 * workflow was not issued for this message and proves nothing about it.
 */
const deliveryKeyFor = (workflowId: string): RegExp =>
  new RegExp(
    `^${workflowId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:delivery:([1-9][0-9]*)$`,
    "u"
  );

/**
 * Syntax alone would accept `:delivery:999` for a message delivered once, so
 * the attempt is bounded by what this message actually issued. The workflow
 * builds the key from `deliveryAttempts + 1` and records that same number when
 * the delivery outcome arrives, so recorded attempts are 1..deliveryAttempts.
 * One more is allowed for the in-flight window: the port writes the envelope
 * before the workflow is told the attempt happened, so a legitimate
 * acknowledgment can name an attempt the board has not recorded yet.
 *
 * What this is NOT: it is a consistency check against the message's own
 * recorded history, under the assumption that only the service writes these
 * mailboxes. It is not cryptographic proof that a delivery was issued and it
 * does not resist tampering by anyone who can write the mailbox file — such a
 * writer could forge any envelope, and no check here would tell.
 */
const isIssuedDeliveryKey = (
  item: SupervisorMessageBoardItem,
  idempotencyKey: string
): boolean => {
  const attempt = deliveryKeyFor(item.workflowId).exec(idempotencyKey)?.[1];
  if (attempt === undefined) {
    return false;
  }
  const parsed = Number(attempt);
  return (
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= item.deliveryAttempts + 1
  );
};

export interface SupervisorMailboxConsumerBinding {
  // The registered mailbox path from the service configuration, never a path
  // derived here: the reconciler must read what delivery actually writes.
  mailbox: string;
  principal: string;
  supervisorId: string;
}

export interface SupervisorMailboxConsumptionResult {
  acknowledged: number;
  claimed: number;
  inspected: number;
  // Envelopes whose target is not the recipient whose mailbox holds them.
  misaddressed: number;
  // Envelopes whose identity does not match the board item they name: a
  // handled envelope must never advance a different message.
  misidentified: number;
  // Keys in a cursor with no matching envelope in that mailbox. A cursor is not
  // evidence on its own, so these are counted and never acted on.
  unmatched: number;
  // Mailboxes that could not be read. Silence there is not an empty queue.
  unreadable: number;
}

export interface SupervisorMailboxConsumptionOptions {
  /**
   * The bounded, async mailbox reads (one per server, shared with the wake
   * driver and delivery). Default: a private one.
   */
  access?: MailboxFileAccess;
  bindings: readonly SupervisorMailboxConsumerBinding[];
  log?: (line: string) => void;
  runtime: SupervisorBridgeConsumptionRuntime;
}

/**
 * An envelope only speaks for the message whose identity it carries whole.
 * Matching the workflow id alone would let a handled envelope advance a
 * DIFFERENT message that happens to be addressed to the same recipient.
 */
const isSameMessage = (
  item: SupervisorMessageBoardItem,
  envelope: MailboxEnvelope
): boolean =>
  item.messageId === envelope.messageId &&
  item.threadId === envelope.threadId &&
  item.to === envelope.target &&
  isIssuedDeliveryKey(item, envelope.idempotencyKey);

type BindingRead =
  | { cursor: MailboxCursor; kind: "read"; outcome: MailboxReadOutcome }
  | { kind: "unavailable"; reason: string };

export class SupervisorMailboxConsumptionReconciler {
  readonly #access: MailboxFileAccess;
  readonly #bindings: readonly SupervisorMailboxConsumerBinding[];
  readonly #log: (line: string) => void;
  /** Bindings whose unreadable mailbox is reported; once per outage. */
  readonly #reportedUnreadable = new Set<string>();
  readonly #runtime: SupervisorBridgeConsumptionRuntime;

  constructor(options: SupervisorMailboxConsumptionOptions) {
    this.#access = options.access ?? new MailboxFileAccess();
    this.#bindings = options.bindings.map((binding) => ({ ...binding }));
    this.#log = options.log ?? (() => undefined);
    this.#runtime = options.runtime;
  }

  /**
   * The mailbox, then its cursor, both async and bounded; unavailable when
   * either cannot be read (an unreadable cursor is not an empty one).
   */
  async #read(binding: SupervisorMailboxConsumerBinding): Promise<BindingRead> {
    const outcome = await this.#access.readMailbox(
      binding.supervisorId,
      binding.mailbox
    );
    if (outcome.kind === "unavailable") {
      return outcome;
    }
    const cursor = await this.#access.readCursor(
      binding.supervisorId,
      mailboxCursorPathFor(binding.mailbox)
    );
    if (cursor.kind === "unavailable") {
      return cursor;
    }
    return { cursor: cursor.cursor, kind: "read", outcome };
  }

  async reconcile(): Promise<SupervisorMailboxConsumptionResult> {
    const result: SupervisorMailboxConsumptionResult = {
      acknowledged: 0,
      claimed: 0,
      inspected: 0,
      misaddressed: 0,
      misidentified: 0,
      unmatched: 0,
      unreadable: 0,
    };
    // Every binding is read at once, each bounded: a mailbox whose open is
    // parked (a macOS privacy prompt) costs that binding alone, and the rest
    // reconcile in the same pass.
    const reads = await Promise.all(
      this.#bindings.map((binding) => this.#read(binding))
    );
    const board = new ReconcilePassBoard(() => this.#runtime.threads());
    for (const [index, binding] of this.#bindings.entries()) {
      const read = reads[index] as BindingRead;
      if (read.kind === "unavailable") {
        result.unreadable += 1;
        this.#reportUnreadable(binding.supervisorId, read.reason);
        continue;
      }
      this.#reportedUnreadable.delete(binding.supervisorId);
      await this.#reconcileBinding(binding, read, result, board);
    }
    return result;
  }

  /** Logged once per outage, not once per pass (a pass runs every 250 ms). */
  #reportUnreadable(supervisorId: string, reason: string): void {
    if (this.#reportedUnreadable.has(supervisorId)) {
      return;
    }
    this.#reportedUnreadable.add(supervisorId);
    this.#log(`[loop] mailbox for ${supervisorId} is unreadable: ${reason}`);
  }

  async #reconcileBinding(
    binding: SupervisorMailboxConsumerBinding,
    read: Extract<BindingRead, { kind: "read" }>,
    result: SupervisorMailboxConsumptionResult,
    board: ReconcilePassBoard
  ): Promise<void> {
    const { cursor, outcome } = read;
    const envelopes = new Map(
      (outcome.kind === "read" ? outcome.entries : []).map(
        (entry) => [entry.idempotencyKey, entry] as const
      )
    );
    for (const key of cursor.consumedIdempotencyKeys) {
      const envelope = envelopes.get(key);
      if (!envelope) {
        // The cursor claims an acknowledgment this mailbox cannot support.
        result.unmatched += 1;
        continue;
      }
      if (envelope.target !== binding.supervisorId) {
        result.misaddressed += 1;
        this.#log(
          `[loop] ${binding.supervisorId} acknowledged ${key}, addressed to ${envelope.target}`
        );
        continue;
      }
      if (!WORKFLOW_ID_RE.test(envelope.workflowId)) {
        result.unmatched += 1;
        continue;
      }
      const item = board.item(envelope.workflowId);
      if (!(item && isSameMessage(item, envelope))) {
        // Either no such message, or an envelope whose identity does not
        // match the one it names. Never advance on a partial match.
        result.misidentified += 1;
        this.#log(
          `[loop] ${binding.supervisorId} acknowledged ${key}, which does not identify ${envelope.workflowId}`
        );
        continue;
      }
      result.inspected += 1;
      await this.#advance(binding, envelope, result, board);
    }
  }

  /**
   * Claim then acknowledge, each under the recipient's own principal, with a
   * request id derived from the envelope so a repeated reconcile is the same
   * request rather than a second effect.
   */
  async #advance(
    binding: SupervisorMailboxConsumerBinding,
    envelope: MailboxEnvelope,
    result: SupervisorMailboxConsumptionResult,
    board: ReconcilePassBoard
  ): Promise<void> {
    const command = {
      claimant: binding.supervisorId,
      principal: binding.principal,
      workflowId: envelope.workflowId,
    };
    const phase = board.phase(envelope.workflowId);
    if (phase === "routed" || phase === "escalated") {
      try {
        await this.#runtime.claim({
          ...command,
          requestId: `mailbox-consume:${envelope.idempotencyKey}:claim`,
        });
      } finally {
        board.changed();
      }
      result.claimed += 1;
    }
    if (board.phase(envelope.workflowId) === "claimed") {
      try {
        await this.#runtime.acknowledge({
          ...command,
          requestId: `mailbox-consume:${envelope.idempotencyKey}:acknowledge`,
        });
      } finally {
        board.changed();
      }
      result.acknowledged += 1;
    }
  }
}

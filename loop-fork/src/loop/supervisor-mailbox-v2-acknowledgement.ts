import type { SupervisorA2AAuthenticatedIdentity } from "./a2a-supervisor-http";
import { MailboxFileAccess } from "./mailbox-file-access";
import {
  isSupervisorMessageV2WorkflowId,
  recipientAckRequestId,
} from "./recipient-api-client";
import { mailboxCursorPathFor } from "./supervisor-mailbox-cursor";
import type { MailboxEnvelope } from "./supervisor-mailbox-delivery";
import type {
  SupervisorMessageV2RecipientLifecycleCommand,
  SupervisorMessageV2RecipientLifecycleOutcome,
} from "./supervisor-message-v2-http";

/**
 * Carries a mailbox recipient's own read acknowledgement of a V2 message to
 * the V2 workflow, on the recipient route, as that recipient.
 *
 * Seen live (2026-10-11): V2 messages delivered to mailbox-only recipients
 * stayed open forever unless someone ran `loop a2a ack`, and the V2 recovery
 * sweep grew with them. The V1 mailbox reconciler never matches a V2 workflow
 * id (by design: one reconciler per protocol), and `loop mailbox ack` can only
 * reach the route from a session that holds the supervisor's own token.
 *
 * What counts as the recipient's acknowledgement is exactly what the V1
 * reconciler accepts: the key is recorded in the recipient's own persisted
 * cursor, and the envelope carrying it is in that recipient's registered
 * mailbox, addressed to that recipient. On top of that the route itself
 * refuses unless the workflow is assigned to this recipient, the recipient is
 * reachable, and (in-process only) the envelope's key is one this workflow's
 * delivery actually issued. Nothing here acknowledges a message whose key is
 * not in the recipient's cursor, so no ACK is made that the recipient's own
 * reader did not make.
 *
 * Trust boundary, stated once: like the V1 reconciler and `loop mailbox`, this
 * assumes only the service and the recipient's reader write these files.
 * Anyone who can write a recipient's mailbox AND cursor can make that
 * recipient's ACK; no check here would tell.
 *
 * Acknowledgement is never completion: this issues claim and acknowledge
 * only, never a result publication. Its request ids are `loop a2a ack`'s, so
 * whichever path acknowledges a message first, the other replays it.
 *
 * Isolation: the caller runs this beside, never inside, V1 reconciliation (no
 * V2 fault may take V1 down). It never throws for a single message: each
 * failure is counted and retried later with backoff, and a message the
 * workflow or the authority refused is settled and not retried.
 */
export interface SupervisorMailboxV2AckBinding {
  // The registered mailbox path from the service configuration.
  mailbox: string;
  principal: string;
  supervisorId: string;
}

export type SupervisorMailboxV2Lifecycle = (
  identity: SupervisorA2AAuthenticatedIdentity,
  command: SupervisorMessageV2RecipientLifecycleCommand
) => Promise<SupervisorMessageV2RecipientLifecycleOutcome>;

export interface SupervisorMailboxV2AckResult {
  /** Acknowledged on the route this pass. */
  acknowledged: number;
  /** Early (delivery or claim not recorded yet): retried when due. */
  early: number;
  /** Failed for a reason that may pass (store, engine, reachability). */
  failed: number;
  /** Consumed V2 envelopes of this recipient, addressed to it. */
  inspected: number;
  /** Consumed keys whose envelope is addressed to another supervisor. */
  misaddressed: number;
  /** Settled this pass by a workflow or authority refusal; not retried. */
  refused: number;
  /** Mailboxes that could not be read. Silence there is not an empty queue. */
  unreadable: number;
  /** Waiting for a retry that is not due, or beyond this pass's budget. */
  waiting: number;
}

export interface SupervisorMailboxV2AckOptions {
  /** The server's bounded, async mailbox reads; omitted, a private one. */
  access?: MailboxFileAccess;
  bindings: readonly SupervisorMailboxV2AckBinding[];
  lifecycle: SupervisorMailboxV2Lifecycle;
  log?: (line: string) => void;
  /** Route commands (claim plus acknowledge) per pass; default 8. */
  maxMessagesPerPass?: number;
  now?: () => number;
}

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 300_000;
const EARLY_MIN_MS = 250;
/**
 * A V2 delivery id's shape, `supervisor-message-delivery:v2:<sha256 hex>`. A
 * prefilter only: whether the key was issued for THIS workflow is the
 * route's check (`deliveryKey`), which knows the message's scope.
 */
const V2_DELIVERY_KEY_RE = /^supervisor-message-delivery:v2:[a-f0-9]{64}$/u;

type Step =
  | { kind: "acknowledged"; phase: string }
  | { kind: "early"; retryAt: null | string }
  | { kind: "failed"; reason: string }
  | { kind: "refused"; reason: string };

interface Pending {
  attempt: number;
  notBefore: number;
  reported: boolean;
}

export class SupervisorMailboxV2AcknowledgementReconciler {
  readonly #access: MailboxFileAccess;
  readonly #bindings: readonly SupervisorMailboxV2AckBinding[];
  readonly #lifecycle: SupervisorMailboxV2Lifecycle;
  readonly #log: (line: string) => void;
  readonly #maxPerPass: number;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  readonly #settled = new Set<string>();

  constructor(options: SupervisorMailboxV2AckOptions) {
    this.#access = options.access ?? new MailboxFileAccess();
    this.#bindings = options.bindings.map((binding) => ({ ...binding }));
    this.#lifecycle = options.lifecycle;
    this.#log = options.log ?? (() => undefined);
    this.#maxPerPass = Math.max(1, options.maxMessagesPerPass ?? 8);
    this.#now = options.now ?? Date.now;
  }

  async reconcile(): Promise<SupervisorMailboxV2AckResult> {
    const result: SupervisorMailboxV2AckResult = {
      acknowledged: 0,
      early: 0,
      failed: 0,
      inspected: 0,
      misaddressed: 0,
      refused: 0,
      unreadable: 0,
      waiting: 0,
    };
    let budget = this.#maxPerPass;
    for (const binding of this.#bindings) {
      const read = await this.#read(binding);
      if (read === "unavailable") {
        result.unreadable += 1;
        continue;
      }
      if (read === "absent") {
        continue;
      }
      const { cursor, envelopes } = read;
      for (const key of cursor.consumedIdempotencyKeys) {
        const envelope = envelopes.get(key);
        if (
          !(
            envelope &&
            isSupervisorMessageV2WorkflowId(envelope.workflowId) &&
            V2_DELIVERY_KEY_RE.test(envelope.idempotencyKey)
          ) ||
          this.#settled.has(envelope.workflowId)
        ) {
          // Not a V2 envelope this cursor can speak for, or already carried.
          continue;
        }
        if (envelope.target !== binding.supervisorId) {
          result.misaddressed += 1;
          continue;
        }
        result.inspected += 1;
        const pending = this.#pending.get(envelope.workflowId);
        if ((pending && pending.notBefore > this.#now()) || budget <= 0) {
          result.waiting += 1;
          continue;
        }
        budget -= 1;
        this.#record(
          binding,
          envelope,
          await this.#acknowledge(binding, envelope),
          result
        );
      }
    }
    return result;
  }

  /**
   * The mailbox's envelopes by idempotency key, then its cursor, both async
   * and bounded; unavailable when either cannot be read.
   */
  async #read(binding: SupervisorMailboxV2AckBinding): Promise<
    | "absent"
    | "unavailable"
    | {
        cursor: { consumedIdempotencyKeys: readonly string[] };
        envelopes: Map<string, MailboxEnvelope>;
      }
  > {
    const outcome = await this.#access.readMailbox(
      binding.supervisorId,
      binding.mailbox
    );
    if (outcome.kind !== "read") {
      return outcome.kind;
    }
    const cursor = await this.#access.readCursor(
      binding.supervisorId,
      mailboxCursorPathFor(binding.mailbox)
    );
    if (cursor.kind === "unavailable") {
      return "unavailable";
    }
    return {
      cursor: cursor.cursor,
      envelopes: new Map(
        outcome.entries.map((entry) => [entry.idempotencyKey, entry] as const)
      ),
    };
  }

  /** Claim, then acknowledge, as `loop a2a ack` does on the HTTP route. */
  async #acknowledge(
    binding: SupervisorMailboxV2AckBinding,
    envelope: MailboxEnvelope
  ): Promise<Step> {
    const identity = {
      principal: binding.principal,
      supervisorId: binding.supervisorId,
    };
    const run = async (operation: "acknowledge" | "claim") => {
      try {
        return await this.#lifecycle(identity, {
          deliveryKey: envelope.idempotencyKey,
          operation,
          requestId: recipientAckRequestId(operation, envelope.workflowId),
          workflowId: envelope.workflowId,
        });
      } catch (error) {
        return error instanceof Error ? error : new Error("unknown error");
      }
    };
    const claim = await run("claim");
    if (claim instanceof Error) {
      return { kind: "failed", reason: `claim: ${claim.message}` };
    }
    if (claim.kind === "refused") {
      if (claim.code === "delivery-not-recorded") {
        return { kind: "early", retryAt: claim.retryAt };
      }
      if (claim.code === "assignment-denied") {
        // Not assigned to this recipient, not reachable now, or a key this
        // workflow never issued: the acknowledge would be refused the same.
        return { kind: "failed", reason: "claim: assignment-denied" };
      }
      // Already claimed by this recipient, or refused: the acknowledge
      // decides, exactly as on the HTTP route's client.
    }
    const acknowledge = await run("acknowledge");
    if (acknowledge instanceof Error) {
      return { kind: "failed", reason: `acknowledge: ${acknowledge.message}` };
    }
    if (acknowledge.kind === "receipt") {
      return { kind: "acknowledged", phase: acknowledge.projection.phase };
    }
    if (
      acknowledge.code === "not-claimed" ||
      acknowledge.code === "delivery-not-recorded"
    ) {
      return { kind: "early", retryAt: acknowledge.retryAt };
    }
    if (
      acknowledge.code === "lifecycle-command-refused" &&
      !acknowledge.transient
    ) {
      // The workflow or the authority decided; the same request id would
      // replay that decision, so retrying cannot change it.
      return { kind: "refused", reason: `acknowledge: ${acknowledge.code}` };
    }
    return { kind: "failed", reason: `acknowledge: ${acknowledge.code}` };
  }

  #record(
    binding: SupervisorMailboxV2AckBinding,
    envelope: MailboxEnvelope,
    step: Step,
    result: SupervisorMailboxV2AckResult
  ): void {
    const workflowId = envelope.workflowId;
    const previous = this.#pending.get(workflowId);
    if (step.kind === "acknowledged" || step.kind === "refused") {
      this.#pending.delete(workflowId);
      this.#settled.add(workflowId);
      if (step.kind === "acknowledged") {
        result.acknowledged += 1;
        this.#log(
          `[loop] ${binding.supervisorId} read ${workflowId} from its mailbox; recipient ACK recorded (${step.phase}); not completion`
        );
      } else {
        result.refused += 1;
        this.#log(
          `[loop] ${binding.supervisorId} read ${workflowId} from its mailbox; recipient ACK refused (${step.reason}); not retried`
        );
      }
      return;
    }
    const attempt = (previous?.attempt ?? 0) + 1;
    const now = this.#now();
    const backoff = Math.min(RETRY_FIRST_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    let delay = backoff;
    if (step.kind === "early") {
      result.early += 1;
      const retryAt =
        step.retryAt === null ? Number.NaN : Date.parse(step.retryAt);
      delay = Number.isFinite(retryAt)
        ? Math.min(Math.max(retryAt - now, EARLY_MIN_MS), RETRY_MAX_MS)
        : backoff;
    } else {
      result.failed += 1;
    }
    const reported = previous?.reported === true;
    if (step.kind === "failed" && !reported) {
      // Once per message until it settles, not once per 250 ms pass.
      this.#log(
        `[loop] ${binding.supervisorId} read ${workflowId} from its mailbox; recipient ACK not recorded yet (${step.reason}); retrying with backoff`
      );
    }
    this.#pending.set(workflowId, {
      attempt,
      notBefore: now + delay,
      reported: reported || step.kind === "failed",
    });
  }
}

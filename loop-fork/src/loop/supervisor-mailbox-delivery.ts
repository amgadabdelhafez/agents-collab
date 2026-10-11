import { dirname, isAbsolute, join, resolve } from "node:path";
import { MailboxFileAccess } from "./mailbox-file-access";
import { supervisorMailboxFileName } from "./supervisor-id";
import type {
  SupervisorMessageDeliveryOutcome,
  SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import type { SupervisorMessageDeliveryRequest } from "./supervisor-message-workflow";

/**
 * Durable delivery for a recipient that cannot be woken: the message is
 * appended to that recipient's mailbox file, which the session reads on its own
 * schedule. This is POLLING-ONLY delivery. "accepted" here means the message is
 * durably readable, never that a session saw it; only its acknowledge proves
 * that.
 */
export interface SupervisorMailboxDirectory {
  resolveMailbox(supervisorId: string): string | undefined;
}

export interface MailboxDeliveryOptions {
  /**
   * The bounded, async file access every mailbox write goes through (one per
   * server, shared with the mailbox readers). Default: a private one.
   */
  access?: MailboxFileAccess;
  directory: SupervisorMailboxDirectory;
  now?: () => string;
}

export interface MailboxEnvelope {
  artifactRefs: string[];
  at: string;
  body: string;
  delivery: "mailbox";
  idempotencyKey: string;
  messageId: string;
  target: string;
  threadId: string;
  workflowId: string;
}

const alreadyDelivered = (text: string, idempotencyKey: string): boolean => {
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { idempotencyKey?: unknown };
      if (entry.idempotencyKey === idempotencyKey) {
        return true;
      }
    } catch {
      // A malformed line cannot prove delivery; keep scanning.
    }
  }
  return false;
};

export class MailboxSupervisorMessageDeliveryPort
  implements SupervisorMessageDeliveryPort
{
  readonly #access: MailboxFileAccess;
  readonly #directory: SupervisorMailboxDirectory;
  readonly #now: () => string;
  /** mailbox path -> the delivery in progress there, so two never interleave. */
  readonly #inProgress = new Map<string, Promise<unknown>>();

  constructor(options: MailboxDeliveryOptions) {
    this.#access = options.access ?? new MailboxFileAccess();
    this.#directory = options.directory;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  deliver(
    request: SupervisorMessageDeliveryRequest
  ): Promise<SupervisorMessageDeliveryOutcome> {
    const mailbox = this.#directory.resolveMailbox(request.target);
    if (!mailbox) {
      return Promise.resolve({
        reason: `no mailbox registered for ${request.target}`,
        status: "transient-failure",
      });
    }
    if (!(isAbsolute(mailbox) && resolve(mailbox) === mailbox)) {
      return Promise.resolve({
        reason: `mailbox for ${request.target} is not an absolute path`,
        status: "permanent-failure",
      });
    }
    // The read-then-append below is one step per mailbox: a concurrent
    // redelivery of the same key must see the first one's append.
    const previous = this.#inProgress.get(mailbox) ?? Promise.resolve();
    const delivery = previous.then(() => this.#append(mailbox, request));
    const tail = delivery.catch(() => undefined);
    this.#inProgress.set(mailbox, tail);
    tail.then(() => {
      if (this.#inProgress.get(mailbox) === tail) {
        this.#inProgress.delete(mailbox);
      }
    });
    return delivery;
  }

  /**
   * Every step is async and bounded (MailboxFileAccess): a mailbox whose open
   * is parked (a macOS privacy prompt) or refused is a transient failure the
   * workflow retries, never a frozen server. An append that lands after its
   * deadline is found by the retry's read, which then adds nothing.
   */
  async #append(
    mailbox: string,
    request: SupervisorMessageDeliveryRequest
  ): Promise<SupervisorMessageDeliveryOutcome> {
    const binding = request.target;
    const existing = await this.#access.access(binding, mailbox, (fs) =>
      fs.readFile(mailbox)
    );
    if (existing.kind === "unavailable") {
      return { reason: existing.reason, status: "transient-failure" };
    }
    // An identical redelivery must not duplicate the recipient's work.
    if (
      existing.kind === "ok" &&
      alreadyDelivered(existing.value, request.idempotencyKey)
    ) {
      return { status: "accepted" };
    }
    const envelope: MailboxEnvelope = {
      artifactRefs: request.artifactRefs,
      at: this.#now(),
      body: request.body,
      delivery: "mailbox",
      idempotencyKey: request.idempotencyKey,
      messageId: request.messageId,
      target: request.target,
      threadId: request.threadId,
      workflowId: request.workflowId,
    };
    const directory = dirname(mailbox);
    const made = await this.#access.access(binding, directory, (fs) =>
      fs.mkdir(directory)
    );
    if (made.kind !== "ok") {
      return {
        reason:
          made.kind === "unavailable"
            ? made.reason
            : `mailbox directory ${directory} could not be created`,
        status: "transient-failure",
      };
    }
    const appended = await this.#access.access(binding, mailbox, (fs) =>
      fs.appendFile(mailbox, `${JSON.stringify(envelope)}\n`)
    );
    if (appended.kind !== "ok") {
      return {
        reason:
          appended.kind === "unavailable"
            ? appended.reason
            : "mailbox write failed",
        status: "transient-failure",
      };
    }
    return { status: "accepted" };
  }
}

/**
 * Try each port in order. A port that reports a transient failure (for example
 * a recipient with no live Loop pane) hands the message to the next one; a
 * permanent failure stops the chain, because retrying it cannot help.
 */
export class FirstAvailableDeliveryPort
  implements SupervisorMessageDeliveryPort
{
  readonly #ports: readonly SupervisorMessageDeliveryPort[];

  constructor(ports: readonly SupervisorMessageDeliveryPort[]) {
    if (ports.length === 0) {
      throw new Error("at least one delivery port is required");
    }
    this.#ports = ports;
  }

  async deliver(
    request: SupervisorMessageDeliveryRequest
  ): Promise<SupervisorMessageDeliveryOutcome> {
    const reasons: string[] = [];
    for (const port of this.#ports) {
      const outcome = await port.deliver(request);
      if (outcome.status === "accepted") {
        return outcome;
      }
      reasons.push(outcome.reason);
      if (outcome.status === "permanent-failure") {
        return { reason: reasons.join("; "), status: "permanent-failure" };
      }
    }
    return { reason: reasons.join("; "), status: "transient-failure" };
  }
}

/**
 * `<root>/supervisor_<slug>.jsonl` (supervisor-id.ts): byte-identical to the
 * historical name for every flat id, collision-free for role ids. Anything
 * but a supervisor id is refused rather than flattened into a name.
 */
export const mailboxPathFor = (root: string, supervisorId: string): string =>
  join(root, supervisorMailboxFileName(supervisorId));

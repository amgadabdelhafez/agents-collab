import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

const alreadyDelivered = (path: string, idempotencyKey: string): boolean => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
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
  readonly #directory: SupervisorMailboxDirectory;
  readonly #now: () => string;

  constructor(options: MailboxDeliveryOptions) {
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
    try {
      // An identical redelivery must not duplicate the recipient's work.
      if (alreadyDelivered(mailbox, request.idempotencyKey)) {
        return Promise.resolve({ status: "accepted" });
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
      mkdirSync(dirname(mailbox), { mode: 0o700, recursive: true });
      appendFileSync(mailbox, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return Promise.resolve({ status: "accepted" });
    } catch (error) {
      return Promise.resolve({
        reason: error instanceof Error ? error.message : "mailbox write failed",
        status: "transient-failure",
      });
    }
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

export const mailboxPathFor = (root: string, supervisorId: string): string =>
  join(root, `${supervisorId.replace(/[^a-z0-9._-]/gu, "_")}.jsonl`);

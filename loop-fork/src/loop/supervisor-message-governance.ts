import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SupervisorMessageCoordinator,
  SupervisorMessageReceiveResult,
} from "./supervisor-message-coordinator";
import {
  parseSupervisorMessageInput,
  type SupervisorMessageInput,
  type SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import { WorkflowError } from "./workflow-port";

export type SupervisorMessageGovernedOperation =
  | "receive"
  | "claim"
  | "acknowledge"
  | "tick"
  | "cancel";

export interface SupervisorMessageAuthorityRequest {
  claimant?: string;
  from: string;
  /** RA2: on a receive, the owner message a reply answers (its message id). */
  inReplyTo?: string;
  operation: SupervisorMessageGovernedOperation;
  principal: string;
  /** RA2: on a receive, the message's own durable identity (dedupe key). */
  replyKey?: string;
  threadId: string;
  to: string;
  workflowId?: string;
}

export interface SupervisorMessageAuthorityDecision {
  allowed: boolean;
  authorityRef: string;
  reasonCode: string;
}

export interface SupervisorMessageAuthorityPort {
  decide(
    request: SupervisorMessageAuthorityRequest
  ):
    | Promise<SupervisorMessageAuthorityDecision>
    | SupervisorMessageAuthorityDecision;
}

export interface SupervisorMessageGovernanceReceipt {
  at: string;
  authorityRef: string;
  decision: "allowed" | "denied";
  from: string;
  operation: SupervisorMessageGovernedOperation;
  principal: string;
  reasonCode: string;
  schema: "supervisor-message-governance-receipt.v1";
  threadId: string;
  to: string;
  workflowId?: string;
}

export interface SupervisorMessageGovernanceReceiptPort {
  record(receipt: SupervisorMessageGovernanceReceipt): Promise<void> | void;
}

export interface GovernedSupervisorMessageServiceOptions {
  authority: SupervisorMessageAuthorityPort;
  coordinator: SupervisorMessageCoordinator;
  now?: () => string;
  receipts: SupervisorMessageGovernanceReceiptPort;
}

export interface GovernedWorkflowCommand {
  claimant?: string;
  principal: string;
  reason?: string;
  requestId: string;
  workflowId: string;
}

const SAFE_REFERENCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;

const requireReference = (value: string, field: string): string => {
  if (!SAFE_REFERENCE_RE.test(value)) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage governance ${field} is invalid`
    );
  }
  return value;
};

const safeReceiptReference = (value: unknown): string =>
  typeof value === "string" && SAFE_REFERENCE_RE.test(value)
    ? value
    : "invalid";

export class SupervisorMessageGovernanceError extends Error {
  readonly authorityRef: string;
  readonly reasonCode: string;

  constructor(decision: SupervisorMessageAuthorityDecision) {
    super(`SupervisorMessage authority denied: ${decision.reasonCode}`);
    this.name = "SupervisorMessageGovernanceError";
    this.authorityRef = decision.authorityRef;
    this.reasonCode = decision.reasonCode;
  }
}

export class JsonlSupervisorMessageReceiptPort
  implements SupervisorMessageGovernanceReceiptPort
{
  readonly #receiptFile: string;

  constructor(receiptFile: string) {
    this.#receiptFile = receiptFile;
  }

  record(receipt: SupervisorMessageGovernanceReceipt): void {
    mkdirSync(dirname(this.#receiptFile), { recursive: true });
    appendFileSync(this.#receiptFile, `${JSON.stringify(receipt)}\n`, "utf8");
  }
}

export class GovernedSupervisorMessageService {
  readonly #authority: SupervisorMessageAuthorityPort;
  readonly #coordinator: SupervisorMessageCoordinator;
  readonly #now: () => string;
  readonly #receipts: SupervisorMessageGovernanceReceiptPort;

  constructor(options: GovernedSupervisorMessageServiceOptions) {
    this.#authority = options.authority;
    this.#coordinator = options.coordinator;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#receipts = options.receipts;
  }

  async receive(
    principal: string,
    input: SupervisorMessageInput,
    requestId: string,
    reply: { inReplyTo?: string } = {}
  ): Promise<SupervisorMessageReceiveResult> {
    let parsed: SupervisorMessageInput;
    try {
      parsed = parseSupervisorMessageInput(input);
    } catch (error) {
      await this.#receipts.record({
        at: this.#now(),
        authorityRef: "input-validation",
        decision: "denied",
        from: safeReceiptReference(input.from),
        operation: "receive",
        principal: safeReceiptReference(principal),
        reasonCode: "invalid-input",
        schema: "supervisor-message-governance-receipt.v1",
        threadId: safeReceiptReference(input.threadId),
        to: safeReceiptReference(input.to),
      });
      throw error;
    }
    await this.#authorize({
      from: parsed.from,
      ...(reply.inReplyTo === undefined
        ? {}
        : { inReplyTo: requireReference(reply.inReplyTo, "inReplyTo") }),
      operation: "receive",
      principal: requireReference(principal, "principal"),
      // The dedupe key names the durable message: a retry of the same
      // message is the same reply.
      replyKey: parsed.dedupeKey,
      threadId: parsed.threadId,
      to: parsed.to,
    });
    return this.#coordinator.receive(parsed, requestId);
  }

  claim(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    const claimant = requireReference(command.claimant ?? "", "claimant");
    return this.#existing("claim", command, () =>
      this.#coordinator.claim(command.workflowId, claimant, command.requestId)
    );
  }

  acknowledge(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    const claimant = requireReference(command.claimant ?? "", "claimant");
    return this.#existing("acknowledge", command, () =>
      this.#coordinator.acknowledge(
        command.workflowId,
        claimant,
        command.requestId
      )
    );
  }

  tick(command: GovernedWorkflowCommand): Promise<SupervisorMessageProjection> {
    return this.#existing("tick", command, () =>
      this.#coordinator.tick(command.workflowId, command.requestId)
    );
  }

  cancel(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    const reason = requireReference(command.reason ?? "", "reason");
    return this.#existing("cancel", command, () =>
      this.#coordinator.cancel(command.workflowId, reason, command.requestId)
    );
  }

  async #existing(
    operation: Exclude<SupervisorMessageGovernedOperation, "receive">,
    command: GovernedWorkflowCommand,
    run: () => Promise<SupervisorMessageProjection>
  ): Promise<SupervisorMessageProjection> {
    const projection = await this.#coordinator.status(command.workflowId);
    await this.#authorize({
      ...(command.claimant ? { claimant: command.claimant } : {}),
      from: projection.from,
      operation,
      principal: requireReference(command.principal, "principal"),
      threadId: projection.threadId,
      to: projection.to,
      workflowId: command.workflowId,
    });
    return run();
  }

  async #authorize(request: SupervisorMessageAuthorityRequest): Promise<void> {
    const raw = await this.#authority.decide(request);
    const decision = {
      allowed: raw.allowed === true,
      authorityRef: requireReference(raw.authorityRef, "authorityRef"),
      reasonCode: requireReference(raw.reasonCode, "reasonCode"),
    };
    await this.#receipts.record({
      at: this.#now(),
      authorityRef: decision.authorityRef,
      decision: decision.allowed ? "allowed" : "denied",
      from: request.from,
      operation: request.operation,
      principal: request.principal,
      reasonCode: decision.reasonCode,
      schema: "supervisor-message-governance-receipt.v1",
      threadId: request.threadId,
      to: request.to,
      ...(request.workflowId ? { workflowId: request.workflowId } : {}),
    });
    if (!decision.allowed) {
      throw new SupervisorMessageGovernanceError(decision);
    }
  }
}

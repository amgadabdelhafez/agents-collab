import { readSupervisorKnowledgeArtifacts } from "./supervisor-knowledge-artifact-read-model";
import type { SupervisorMessageReceiveResult } from "./supervisor-message-coordinator";
import type {
  GovernedSupervisorMessageService,
  GovernedWorkflowCommand,
} from "./supervisor-message-governance";
import {
  parseSupervisorMessageBoardItem,
  type SupervisorMessageBoardItem,
} from "./supervisor-message-read-model";
import type {
  SupervisorMessageInput,
  SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import { readSupervisorThreadAttention } from "./supervisor-thread-attention-read-model";
import type {
  JsonlSupervisorThreadStore,
  SupervisorThreadMessageKind,
} from "./supervisor-thread-store";

export interface SupervisorMessageReceiveCommand {
  input: SupervisorMessageInput;
  /**
   * RA2: the owner message a reply to the owner answers (its message id).
   * Governance resolves it server-side; it is not part of the message.
   */
  inReplyTo?: string;
  messageKind: SupervisorThreadMessageKind;
  principal: string;
  requestId: string;
}

export interface SupervisorOrchestrationRuntimeOptions {
  governed: GovernedSupervisorMessageService;
  /**
   * RA2: told of each message once it is durably accepted (governed receive
   * and thread-board append both done). A throw is swallowed: the message
   * is accepted either way.
   */
  onReceived?: (accepted: {
    from: string;
    messageId: string;
    to: string;
  }) => void;
  store: JsonlSupervisorThreadStore;
}

type ExistingOperation = "acknowledge" | "cancel" | "claim" | "tick";

const boardItem = (
  workflowId: string,
  projection: SupervisorMessageProjection
): SupervisorMessageBoardItem =>
  parseSupervisorMessageBoardItem({
    ...projection,
    schema: "supervisor-message-board-item.v1",
    workflowId,
  });

const projectionInstant = (projection: SupervisorMessageProjection): string =>
  projection.acknowledgedAt ??
  projection.deadLetteredAt ??
  projection.claimedAt ??
  projection.escalatedAt ??
  projection.nextRetryAt ??
  projection.deliveredAt ??
  projection.receivedAt;

export class SupervisorOrchestrationRuntime {
  readonly #governed: GovernedSupervisorMessageService;
  readonly #onReceived: SupervisorOrchestrationRuntimeOptions["onReceived"];
  readonly #store: JsonlSupervisorThreadStore;

  constructor(options: SupervisorOrchestrationRuntimeOptions) {
    this.#governed = options.governed;
    this.#onReceived = options.onReceived;
    this.#store = options.store;
  }

  async receive(
    command: SupervisorMessageReceiveCommand
  ): Promise<SupervisorMessageReceiveResult> {
    const result = await this.#governed.receive(
      command.principal,
      command.input,
      command.requestId,
      command.inReplyTo === undefined ? {} : { inReplyTo: command.inReplyTo }
    );
    this.#persist(
      "receive",
      command.requestId,
      result.workflowId,
      result.projection,
      command.messageKind
    );
    try {
      this.#onReceived?.({
        from: result.projection.from,
        messageId: result.projection.messageId,
        to: result.projection.to,
      });
    } catch {
      // Accepted either way; the hook owns its own failure.
    }
    return structuredClone(result);
  }

  acknowledge(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    return this.#existing("acknowledge", command);
  }

  cancel(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    return this.#existing("cancel", command);
  }

  claim(
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    return this.#existing("claim", command);
  }

  tick(command: GovernedWorkflowCommand): Promise<SupervisorMessageProjection> {
    return this.#existing("tick", command);
  }

  threads() {
    return this.#store.read();
  }

  attention() {
    return readSupervisorThreadAttention(this.#store);
  }

  knowledge() {
    return readSupervisorKnowledgeArtifacts(this.#store);
  }

  async #existing(
    operation: ExistingOperation,
    command: GovernedWorkflowCommand
  ): Promise<SupervisorMessageProjection> {
    const messageKind = this.#messageKind(command.workflowId);
    const projection = await this.#governed[operation](command);
    this.#persist(
      operation,
      command.requestId,
      command.workflowId,
      projection,
      messageKind
    );
    return structuredClone(projection);
  }

  #messageKind(workflowId: string): SupervisorThreadMessageKind {
    const matches = this.#store
      .read()
      .threads.flatMap((thread) => thread.messages)
      .filter((message) => message.item.workflowId === workflowId);
    const [match] = matches;
    if (!(match && matches.length === 1)) {
      throw new Error(
        `workflow ${workflowId} has no unique durable message category`
      );
    }
    return match.messageKind;
  }

  #persist(
    operation: "receive" | ExistingOperation,
    requestId: string,
    workflowId: string,
    projection: SupervisorMessageProjection,
    messageKind: SupervisorThreadMessageKind
  ): void {
    this.#store.append({
      item: boardItem(workflowId, projection),
      messageKind,
      observedAt: projectionInstant(projection),
      requestId: `${operation}:${requestId}`,
    });
  }
}

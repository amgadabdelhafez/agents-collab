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
  messageKind: SupervisorThreadMessageKind;
  principal: string;
  requestId: string;
}

export interface SupervisorOrchestrationRuntimeOptions {
  governed: GovernedSupervisorMessageService;
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
  readonly #store: JsonlSupervisorThreadStore;

  constructor(options: SupervisorOrchestrationRuntimeOptions) {
    this.#governed = options.governed;
    this.#store = options.store;
  }

  async receive(
    command: SupervisorMessageReceiveCommand
  ): Promise<SupervisorMessageReceiveResult> {
    const result = await this.#governed.receive(
      command.principal,
      command.input,
      command.requestId
    );
    this.#persist(
      "receive",
      command.requestId,
      result.workflowId,
      result.projection,
      command.messageKind
    );
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

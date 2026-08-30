import { type BridgeMessage, readBridgeEvents } from "./bridge-store";
import type { SupervisorBridgeDirectory } from "./bridge-supervisor-message-delivery";
import type { GovernedWorkflowCommand } from "./supervisor-message-governance";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";
import type { SupervisorThreadBoardProjection } from "./supervisor-thread-store";

export interface SupervisorBridgeConsumerBinding {
  principal: string;
  supervisorId: string;
}

export interface SupervisorBridgeConsumptionRuntime {
  acknowledge(command: GovernedWorkflowCommand): Promise<unknown>;
  claim(command: GovernedWorkflowCommand): Promise<unknown>;
  threads(): SupervisorThreadBoardProjection;
}

export interface SupervisorBridgeConsumptionResult {
  acknowledged: number;
  claimed: number;
  inspected: number;
}

export interface SupervisorBridgeConsumptionOptions {
  bindings: readonly SupervisorBridgeConsumerBinding[];
  directory: SupervisorBridgeDirectory;
  runtime: SupervisorBridgeConsumptionRuntime;
}

const WORKFLOW_ID_RE = /^supervisor-message:[a-f0-9]{64}$/;
const PULL_ACK_REASON = "read via receive_messages";

const latestPhase = (
  threads: SupervisorThreadBoardProjection,
  workflowId: string
): SupervisorMessagePhase | undefined =>
  threads.threads
    .flatMap((thread) => thread.messages)
    .find((message) => message.item.workflowId === workflowId)?.item.phase;

const isOrchestrationMessage = (
  value: BridgeMessage,
  target: BridgeMessage["target"]
): boolean =>
  value.source === "supervisor" &&
  value.target === target &&
  value.type === "work_request" &&
  typeof value.taskId === "string" &&
  WORKFLOW_ID_RE.test(value.taskId);

export class SupervisorBridgeConsumptionReconciler {
  readonly #bindings: readonly SupervisorBridgeConsumerBinding[];
  readonly #directory: SupervisorBridgeDirectory;
  readonly #runtime: SupervisorBridgeConsumptionRuntime;

  constructor(options: SupervisorBridgeConsumptionOptions) {
    this.#bindings = options.bindings.map((binding) => ({ ...binding }));
    this.#directory = options.directory;
    this.#runtime = options.runtime;
  }

  async reconcile(): Promise<SupervisorBridgeConsumptionResult> {
    const result: SupervisorBridgeConsumptionResult = {
      acknowledged: 0,
      claimed: 0,
      inspected: 0,
    };
    for (const binding of this.#bindings) {
      const route = await this.#directory.resolve(binding.supervisorId);
      if (!route || route.target === "supervisor") {
        continue;
      }
      const events = readBridgeEvents(route.runDir);
      const consumedIds = new Set(
        events
          .filter(
            (event) =>
              event.kind === "delivered" &&
              event.reason === PULL_ACK_REASON &&
              event.target === route.target
          )
          .map((event) => event.id)
      );
      const messages = events.filter(
        (event): event is BridgeMessage =>
          event.kind === "message" &&
          consumedIds.has(event.id) &&
          isOrchestrationMessage(event, route.target)
      );
      for (const message of messages) {
        result.inspected += 1;
        const workflowId = message.taskId as string;
        const phase = latestPhase(this.#runtime.threads(), workflowId);
        const command = {
          claimant: binding.supervisorId,
          principal: binding.principal,
          workflowId,
        };
        if (phase === "routed" || phase === "escalated") {
          await this.#runtime.claim({
            ...command,
            requestId: `bridge-consume:${message.id}:claim`,
          });
          result.claimed += 1;
        }
        const afterClaim = latestPhase(this.#runtime.threads(), workflowId);
        if (afterClaim === "claimed") {
          await this.#runtime.acknowledge({
            ...command,
            requestId: `bridge-consume:${message.id}:acknowledge`,
          });
          result.acknowledged += 1;
        }
      }
    }
    return result;
  }
}

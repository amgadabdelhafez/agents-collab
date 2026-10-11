import { type BridgeMessage, readBridgeEvents } from "./bridge-store";
import type { SupervisorBridgeDirectory } from "./bridge-supervisor-message-delivery";
import type { GovernedWorkflowCommand } from "./supervisor-message-governance";
import { ReconcilePassBoard } from "./supervisor-reconcile-board";
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
    // One board read per pass, again only after this pass wrote.
    const board = new ReconcilePassBoard(() => this.#runtime.threads());
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
        const phase = board.phase(workflowId);
        const command = {
          claimant: binding.supervisorId,
          principal: binding.principal,
          workflowId,
        };
        if (phase === "routed" || phase === "escalated") {
          try {
            await this.#runtime.claim({
              ...command,
              requestId: `bridge-consume:${message.id}:claim`,
            });
          } finally {
            board.changed();
          }
          result.claimed += 1;
        }
        const afterClaim = board.phase(workflowId);
        if (afterClaim === "claimed") {
          try {
            await this.#runtime.acknowledge({
              ...command,
              requestId: `bridge-consume:${message.id}:acknowledge`,
            });
          } finally {
            board.changed();
          }
          result.acknowledged += 1;
        }
      }
    }
    return result;
  }
}

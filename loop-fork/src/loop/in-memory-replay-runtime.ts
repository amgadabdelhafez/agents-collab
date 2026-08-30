import { InMemoryWorkflowPort } from "./in-memory-workflow-port";
import type {
  SupervisorMessageDeliveryOutcome,
  SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import {
  type SupervisorMessageDeliveryRequest,
  supervisorMessageWorkflowDefinition,
} from "./supervisor-message-workflow";
import type { WorkflowPort } from "./workflow-port";
import type { SupervisorMessageReplayRuntime } from "./workflow-replay-corpus";

export class InMemorySupervisorMessageReplayRuntime
  implements SupervisorMessageReplayRuntime
{
  readonly delivery: SupervisorMessageDeliveryPort;
  readonly #deliveries: SupervisorMessageDeliveryRequest[] = [];
  readonly #port: InMemoryWorkflowPort;
  #deliveryIndex = 0;
  #deliveryOutcomes: readonly SupervisorMessageDeliveryOutcome[] = [];
  #now = "2026-08-30T04:00:00.000Z";
  #workerGeneration = 1;
  #workerVersion = "supervisor-message.v1-worker";

  constructor() {
    this.#port = new InMemoryWorkflowPort({
      definitions: [supervisorMessageWorkflowDefinition],
      now: () => this.#now,
    });
    this.delivery = {
      deliver: (request) => {
        const outcome = this.#deliveryOutcomes[this.#deliveryIndex];
        if (!outcome) {
          throw new Error(
            `fixture did not define delivery outcome ${this.#deliveryIndex + 1}`
          );
        }
        this.#deliveryIndex += 1;
        this.#deliveries.push(structuredClone(request));
        return Promise.resolve(structuredClone(outcome));
      },
    };
  }

  deliveries(): readonly SupervisorMessageDeliveryRequest[] {
    return structuredClone(this.#deliveries);
  }

  restartWorker(): void {
    this.#workerGeneration += 1;
  }

  setClock(at: string): void {
    this.#now = at;
  }

  setDeliveryOutcomes(
    outcomes: readonly SupervisorMessageDeliveryOutcome[]
  ): void {
    this.#deliveryOutcomes = structuredClone(outcomes);
    this.#deliveryIndex = 0;
  }

  upgradeWorker(version: string): void {
    this.#workerGeneration += 1;
    this.#workerVersion = version;
  }

  workflowPort(): WorkflowPort {
    return this.#port;
  }

  workerIdentity(): { generation: number; version: string } {
    return {
      generation: this.#workerGeneration,
      version: this.#workerVersion,
    };
  }
}

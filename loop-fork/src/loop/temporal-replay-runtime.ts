import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type {
  SupervisorMessageDeliveryOutcome,
  SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import type { SupervisorMessageDeliveryRequest } from "./supervisor-message-workflow";
import { TemporalWorkflowPort } from "./temporal-workflow-port";
import type { WorkflowPort } from "./workflow-port";
import type { SupervisorMessageReplayRuntime } from "./workflow-replay-corpus";

export class TemporalSupervisorMessageReplayRuntime
  implements SupervisorMessageReplayRuntime
{
  readonly delivery: SupervisorMessageDeliveryPort;
  readonly #environment: TestWorkflowEnvironment;
  readonly #taskQueue: string;
  readonly #deliveries: SupervisorMessageDeliveryRequest[] = [];
  #deliveryIndex = 0;
  #deliveryOutcomes: readonly SupervisorMessageDeliveryOutcome[] = [];
  #now = "2026-08-30T04:00:00.000Z";
  readonly #port: TemporalWorkflowPort;
  #worker: Worker | undefined;
  #workerGeneration = 1;
  #workerRun: Promise<void> | undefined;
  #workerVersion = "supervisor-message.v1-worker";

  private constructor(environment: TestWorkflowEnvironment, taskQueue: string) {
    this.#environment = environment;
    this.#taskQueue = taskQueue;
    this.#port = new TemporalWorkflowPort(environment.client.workflow, {
      now: () => this.#now,
      taskQueue,
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

  static async create(
    taskQueue = `orch-temporal-replay-${process.pid}`
  ): Promise<TemporalSupervisorMessageReplayRuntime> {
    const environment = await TestWorkflowEnvironment.createLocal();
    const runtime = new TemporalSupervisorMessageReplayRuntime(
      environment,
      taskQueue
    );
    await runtime.#startWorker();
    return runtime;
  }

  async close(): Promise<void> {
    await this.#stopWorker();
    await this.#environment.teardown();
  }

  deliveries(): readonly SupervisorMessageDeliveryRequest[] {
    return structuredClone(this.#deliveries);
  }

  async restartWorker(): Promise<void> {
    await this.#stopWorker();
    this.#workerGeneration += 1;
    await this.#startWorker();
  }

  setClock(at: string): void {
    this.#now = at;
  }

  setDeliveryOutcomes(
    outcomes: readonly SupervisorMessageDeliveryOutcome[]
  ): void {
    this.#deliveryOutcomes = structuredClone(outcomes);
    this.#deliveryIndex = 0;
    this.#deliveries.length = 0;
    this.#now = "2026-08-30T04:00:00.000Z";
  }

  async upgradeWorker(version: string): Promise<void> {
    await this.#stopWorker();
    this.#workerGeneration += 1;
    this.#workerVersion = version;
    await this.#startWorker();
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

  async #startWorker(): Promise<void> {
    this.#worker = await Worker.create({
      buildId: this.#workerVersion,
      connection: this.#environment.nativeConnection,
      identity: `${this.#workerVersion}@orch-temporal-test`,
      namespace: this.#environment.namespace,
      taskQueue: this.#taskQueue,
      workflowsPath: new URL("./temporal-workflow.ts", import.meta.url)
        .pathname,
    });
    this.#workerRun = this.#worker.run();
  }

  async #stopWorker(): Promise<void> {
    const worker = this.#worker;
    const run = this.#workerRun;
    this.#worker = undefined;
    this.#workerRun = undefined;
    if (!(worker && run)) {
      return;
    }
    if (worker.getState() === "RUNNING") {
      worker.shutdown();
    }
    await run.catch((error) => {
      if (worker.getState() !== "STOPPED") {
        throw error;
      }
    });
  }
}

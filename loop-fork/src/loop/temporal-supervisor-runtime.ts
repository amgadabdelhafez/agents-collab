import { type NativeConnection, Worker } from "@temporalio/worker";
import type { SupervisorMessageDeliveryPort } from "./supervisor-message-coordinator";
import { SupervisorMessageCoordinator } from "./supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  type SupervisorMessageAuthorityPort,
  type SupervisorMessageGovernanceReceiptPort,
} from "./supervisor-message-governance";
import { SupervisorOrchestrationRuntime } from "./supervisor-orchestration-runtime";
import type { JsonlSupervisorThreadStore } from "./supervisor-thread-store";
import { TemporalWorkflowPort } from "./temporal-workflow-port";

export interface TemporalSupervisorRuntimeOptions {
  authority: SupervisorMessageAuthorityPort;
  buildId: string;
  delivery: SupervisorMessageDeliveryPort;
  identity: string;
  namespace: string;
  nativeConnection: unknown;
  receipts: SupervisorMessageGovernanceReceiptPort;
  store: JsonlSupervisorThreadStore;
  taskQueue: string;
  workflowClient: unknown;
  workflowsPath: string;
}

const SAFE_RUNTIME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

const requireRuntimeName = (value: string, field: string): string => {
  if (!SAFE_RUNTIME_NAME_RE.test(value)) {
    throw new Error(`Temporal supervisor ${field} is invalid`);
  }
  return value;
};

const requireWorkflowPath = (value: string): string => {
  if (!(value && value.length <= 4096 && !value.includes("\0"))) {
    throw new Error("Temporal supervisor workflowsPath is invalid");
  }
  return value;
};

export class TemporalSupervisorRuntimeHost {
  readonly runtime: SupervisorOrchestrationRuntime;
  readonly #worker: Worker;
  readonly #workerRun: Promise<void>;
  #closed = false;

  private constructor(
    runtime: SupervisorOrchestrationRuntime,
    worker: Worker,
    workerRun: Promise<void>
  ) {
    this.runtime = runtime;
    this.#worker = worker;
    this.#workerRun = workerRun;
  }

  static async create(
    options: TemporalSupervisorRuntimeOptions
  ): Promise<TemporalSupervisorRuntimeHost> {
    const taskQueue = requireRuntimeName(options.taskQueue, "taskQueue");
    const workflowsPath = requireWorkflowPath(options.workflowsPath);
    const workflows = new TemporalWorkflowPort(options.workflowClient, {
      taskQueue,
    });
    const coordinator = new SupervisorMessageCoordinator(
      workflows,
      options.delivery
    );
    const governed = new GovernedSupervisorMessageService({
      authority: options.authority,
      coordinator,
      receipts: options.receipts,
    });
    const runtime = new SupervisorOrchestrationRuntime({
      governed,
      store: options.store,
    });
    const worker = await Worker.create({
      buildId: requireRuntimeName(options.buildId, "buildId"),
      connection: options.nativeConnection as NativeConnection,
      identity: requireRuntimeName(options.identity, "identity"),
      namespace: requireRuntimeName(options.namespace, "namespace"),
      taskQueue,
      workflowsPath,
    });
    const workerRun = worker.run();
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (worker.getState() === "RUNNING") {
          return new TemporalSupervisorRuntimeHost(runtime, worker, workerRun);
        }
        await Promise.race([
          workerRun.then(() => {
            throw new Error("Temporal supervisor worker exited during startup");
          }),
          new Promise((resolve) => setTimeout(resolve, 10)),
        ]);
      }
      throw new Error("Temporal supervisor worker did not become ready");
    } catch (error) {
      if (worker.getState() === "RUNNING") {
        worker.shutdown();
      }
      await workerRun.catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#worker.getState() === "RUNNING") {
      this.#worker.shutdown();
    }
    await this.#workerRun;
  }

  workerState(): string {
    return this.#worker.getState();
  }
}

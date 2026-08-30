import { type NativeConnection, Worker } from "@temporalio/worker";
import type { SupervisorMessageDeliveryPort } from "./supervisor-message-coordinator";
import { SupervisorMessageCoordinator } from "./supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  type SupervisorMessageAuthorityPort,
  type SupervisorMessageGovernanceReceiptPort,
} from "./supervisor-message-governance";
import {
  createSupervisorOrchestrationHttpHandler,
  type SupervisorControlSurfaceAuthenticator,
} from "./supervisor-orchestration-http";
import { SupervisorOrchestrationRuntime } from "./supervisor-orchestration-runtime";
import type { JsonlSupervisorThreadStore } from "./supervisor-thread-store";
import { TaskGraphRuntime } from "./task-graph-runtime";
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
  workflowBundle?: { code: string };
  workflowClient: unknown;
  workflowsPath?: string;
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

const requireWorkflowSource = (
  options: Pick<
    TemporalSupervisorRuntimeOptions,
    "workflowBundle" | "workflowsPath"
  >
): { workflowBundle: { code: string } } | { workflowsPath: string } => {
  if (options.workflowBundle && options.workflowsPath) {
    throw new Error("Temporal supervisor workflow source is ambiguous");
  }
  if (options.workflowBundle) {
    if (!options.workflowBundle.code) {
      throw new Error("Temporal supervisor workflowBundle is invalid");
    }
    return { workflowBundle: options.workflowBundle };
  }
  if (options.workflowsPath) {
    return { workflowsPath: requireWorkflowPath(options.workflowsPath) };
  }
  throw new Error("Temporal supervisor workflow source is missing");
};

export class TemporalSupervisorRuntimeHost {
  readonly runtime: SupervisorOrchestrationRuntime;
  readonly tasks: TaskGraphRuntime;
  readonly #worker: Worker;
  readonly #workerRun: Promise<void>;
  #closed = false;

  private constructor(
    runtime: SupervisorOrchestrationRuntime,
    tasks: TaskGraphRuntime,
    worker: Worker,
    workerRun: Promise<void>
  ) {
    this.runtime = runtime;
    this.tasks = tasks;
    this.#worker = worker;
    this.#workerRun = workerRun;
  }

  static async create(
    options: TemporalSupervisorRuntimeOptions
  ): Promise<TemporalSupervisorRuntimeHost> {
    const taskQueue = requireRuntimeName(options.taskQueue, "taskQueue");
    const workflowSource = requireWorkflowSource(options);
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
    const tasks = new TaskGraphRuntime({ workflows });
    const worker = await Worker.create({
      buildId: requireRuntimeName(options.buildId, "buildId"),
      connection: options.nativeConnection as NativeConnection,
      identity: requireRuntimeName(options.identity, "identity"),
      namespace: requireRuntimeName(options.namespace, "namespace"),
      taskQueue,
      ...workflowSource,
    });
    const workerRun = worker.run();
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (worker.getState() === "RUNNING") {
          return new TemporalSupervisorRuntimeHost(
            runtime,
            tasks,
            worker,
            workerRun
          );
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

  httpHandler(
    authenticator: SupervisorControlSurfaceAuthenticator
  ): (request: Request) => Promise<Response> {
    return createSupervisorOrchestrationHttpHandler({
      authenticator,
      messages: this.runtime,
      tasks: this.tasks,
    });
  }
}

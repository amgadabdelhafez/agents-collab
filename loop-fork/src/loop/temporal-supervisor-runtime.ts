import { type NativeConnection, Worker } from "@temporalio/worker";
import type { SupervisorA2AV2IngressLifecycle } from "./a2a-supervisor-v2-ingress";
import type { SupervisorMessageDeliveryPort } from "./supervisor-message-coordinator";
import { SupervisorMessageCoordinator } from "./supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  type SupervisorMessageAuthorityPort,
  type SupervisorMessageGovernanceReceiptPort,
} from "./supervisor-message-governance";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import type { SupervisorMessageV2RecoveryLifecycle } from "./supervisor-message-v2-runtime";
import {
  createSupervisorOrchestrationHttpHandler,
  type SupervisorControlSurfaceAuthenticator,
} from "./supervisor-orchestration-http";
import { SupervisorOrchestrationRuntime } from "./supervisor-orchestration-runtime";
import type {
  SupervisorSessionV2DagGateQuery,
  SupervisorSessionV2DagGateStatus,
} from "./supervisor-session-v2-dag-adapter";
import type { JsonlSupervisorThreadStore } from "./supervisor-thread-store";
import { TaskGraphRuntime } from "./task-graph-runtime";
import { TemporalWorkflowPort } from "./temporal-workflow-port";
import type { WorkflowPort } from "./workflow-port";

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
  /**
   * The strict V2 control-plane path. It is paired with a passive scoped
   * session-gate query so a host cannot claim V2 routing without the shared
   * readiness boundary.
   */
  v2Ingress?: SupervisorA2AV2IngressLifecycle;
  /**
   * V2 recovery is deliberately explicit. The host starts its durable sweep
   * only when the V2 ingress and its PostgreSQL ledger have been configured by
   * the owning service; V1-only deployments keep their existing behavior.
   */
  v2Recovery?: SupervisorMessageV2RecoveryLifecycle;
  v2SessionGates?: SupervisorSessionV2DagGateQuery;
  workflowBundle?: { code: string };
  workflowClient: unknown;
  workflowExecution?: "in-process" | "threaded";
  /**
   * An explicitly composed workflow port. The standard V2 service passes one
   * shared port to the host and ingress so they use the same Temporal client
   * and task-queue contract. Existing V1 callers retain the default port.
   */
  workflowPort?: WorkflowPort;
  workflowsPath?: string;
}

const SAFE_RUNTIME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

const requireRuntimeName = (value: string, field: string): string => {
  // `RegExp.test` coerces: an absent value would pass as "undefined".
  if (typeof value !== "string" || !SAFE_RUNTIME_NAME_RE.test(value)) {
    throw new Error(`Temporal supervisor ${field} is invalid`);
  }
  return value;
};

/** The namespace a Temporal `WorkflowClient` was constructed for, if any. */
const clientNamespace = (client: unknown): unknown =>
  typeof client === "object" &&
  client !== null &&
  "options" in client &&
  typeof client.options === "object" &&
  client.options !== null &&
  "namespace" in client.options
    ? client.options.namespace
    : undefined;

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

interface V2HostControl {
  lifecycle: SupervisorMessageV2RecoveryLifecycle | undefined;
  sessionGates: SupervisorSessionV2DagGateQuery | undefined;
}

const requireLifecycle = (
  value: unknown,
  field: string
): SupervisorMessageV2RecoveryLifecycle => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { close?: unknown }).close !== "function" ||
    typeof (value as { start?: unknown }).start !== "function"
  ) {
    throw new Error(`Temporal supervisor ${field} is invalid`);
  }
  return value as SupervisorMessageV2RecoveryLifecycle;
};

const requireSessionGateQuery = (
  value: unknown
): SupervisorSessionV2DagGateQuery => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { status?: unknown }).status !== "function"
  ) {
    throw new Error("Temporal supervisor V2 session gate query is invalid");
  }
  return value as SupervisorSessionV2DagGateQuery;
};

const resolveV2HostControl = (
  options: Pick<
    TemporalSupervisorRuntimeOptions,
    "v2Ingress" | "v2Recovery" | "v2SessionGates"
  >
): V2HostControl => {
  const hasIngress = options.v2Ingress !== undefined;
  const hasSessionGates = options.v2SessionGates !== undefined;
  if (hasIngress !== hasSessionGates) {
    throw new Error(
      "Temporal supervisor V2 ingress and session gate query must be paired"
    );
  }
  if (hasIngress && options.v2Recovery !== undefined) {
    throw new Error("Temporal supervisor V2 lifecycle is ambiguous");
  }
  if (hasIngress) {
    return {
      lifecycle: requireLifecycle(options.v2Ingress, "V2 ingress"),
      sessionGates: requireSessionGateQuery(options.v2SessionGates),
    };
  }
  return {
    lifecycle:
      options.v2Recovery === undefined
        ? undefined
        : requireLifecycle(options.v2Recovery, "V2 recovery"),
    sessionGates: undefined,
  };
};

export class TemporalSupervisorRuntimeHost {
  readonly runtime: SupervisorOrchestrationRuntime;
  readonly tasks: TaskGraphRuntime;
  readonly #worker: Worker;
  readonly #workerRun: Promise<void>;
  readonly #v2Lifecycle: SupervisorMessageV2RecoveryLifecycle | undefined;
  readonly #v2SessionGates: SupervisorSessionV2DagGateQuery | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(
    runtime: SupervisorOrchestrationRuntime,
    tasks: TaskGraphRuntime,
    worker: Worker,
    workerRun: Promise<void>,
    v2Control: V2HostControl
  ) {
    this.runtime = runtime;
    this.tasks = tasks;
    this.#worker = worker;
    this.#workerRun = workerRun;
    this.#v2Lifecycle = v2Control.lifecycle;
    this.#v2SessionGates = v2Control.sessionGates;
  }

  static async create(
    options: TemporalSupervisorRuntimeOptions
  ): Promise<TemporalSupervisorRuntimeHost> {
    const taskQueue = requireRuntimeName(options.taskQueue, "taskQueue");
    const workflowSource = requireWorkflowSource(options);
    const v2Control = resolveV2HostControl(options);
    const workflows =
      options.workflowPort ??
      new TemporalWorkflowPort(options.workflowClient, { taskQueue });
    // The task queue is this deployment's discriminator: the port starts and
    // adopts executions only on it, so it must be the queue this worker polls.
    if (workflows.taskQueue !== taskQueue) {
      throw new Error(
        "Temporal supervisor workflowPort task queue does not match its worker"
      );
    }
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
    const workflowExecution = options.workflowExecution ?? "threaded";
    if (
      workflowExecution !== "in-process" &&
      workflowExecution !== "threaded"
    ) {
      throw new Error("Temporal supervisor workflowExecution is invalid");
    }
    const namespace = requireRuntimeName(options.namespace, "namespace");
    // Workflow IDs are unique per namespace. A client in another namespace
    // would start executions this worker never runs and read foreign ones.
    if (clientNamespace(options.workflowClient) !== namespace) {
      throw new Error(
        "Temporal supervisor workflowClient namespace does not match its worker"
      );
    }
    const worker = await Worker.create({
      buildId: requireRuntimeName(options.buildId, "buildId"),
      connection: options.nativeConnection as NativeConnection,
      debugMode: workflowExecution === "in-process",
      identity: requireRuntimeName(options.identity, "identity"),
      namespace,
      taskQueue,
      ...workflowSource,
    });
    const workerRun = worker.run();
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (worker.getState() === "RUNNING") {
          await v2Control.lifecycle?.start();
          return new TemporalSupervisorRuntimeHost(
            runtime,
            tasks,
            worker,
            workerRun,
            v2Control
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
      await v2Control.lifecycle?.close().catch(() => undefined);
      if (worker.getState() === "RUNNING") {
        worker.shutdown();
      }
      await workerRun.catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = this.#close();
    }
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    let recoveryError: unknown;
    try {
      await this.#v2Lifecycle?.close();
    } catch (error) {
      recoveryError = error;
    }
    if (this.#worker.getState() === "RUNNING") {
      this.#worker.shutdown();
    }
    await this.#workerRun;
    if (recoveryError) {
      throw recoveryError;
    }
  }

  workerState(): string {
    return this.#worker.getState();
  }

  sessionGateStatus(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionV2DagGateStatus> {
    if (this.#closed) {
      throw new Error("Temporal supervisor runtime host is closed");
    }
    if (!this.#v2SessionGates) {
      throw new Error("Temporal supervisor V2 session gates are unavailable");
    }
    return this.#v2SessionGates.status(trustedScope, recipient);
  }

  httpHandler(
    authenticator: SupervisorControlSurfaceAuthenticator,
    options: {
      resolveRecipient?: (recipient: string) => string;
      resultGraphRoutePath?: string;
    } = {}
  ): (request: Request) => Promise<Response> {
    return createSupervisorOrchestrationHttpHandler({
      authenticator,
      messages: this.runtime,
      ...(options.resolveRecipient
        ? { resolveRecipient: options.resolveRecipient }
        : {}),
      resultGraphRoutePath: options.resultGraphRoutePath,
      tasks: this.tasks,
    });
  }
}

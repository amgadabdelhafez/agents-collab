import { TASK_GRAPH_WORKFLOW_TYPE } from "./task-graph-workflow";
import type {
  JsonObject,
  WorkflowCommandReceipt,
  WorkflowPort,
  WorkflowQueryResult,
  WorkflowStartReceipt,
} from "./workflow-port";

export interface TaskGraphRuntimeOptions {
  workflows: WorkflowPort;
}

export interface TaskGraphStartCommand {
  input: JsonObject;
  requestId: string;
  workflowId: string;
}

export interface TaskGraphMutationCommand {
  payload: JsonObject;
  requestId: string;
  workflowId: string;
}

export interface TaskGraphWorkerCommand {
  requestId: string;
  taskId: string;
  workerId: string;
  workflowId: string;
}

export class TaskGraphRuntime {
  readonly #workflows: WorkflowPort;

  constructor(options: TaskGraphRuntimeOptions) {
    this.#workflows = options.workflows;
  }

  start(command: TaskGraphStartCommand): Promise<WorkflowStartReceipt> {
    return Promise.resolve(
      this.#workflows.start({
        input: command.input,
        requestId: command.requestId,
        workflowId: command.workflowId,
        workflowType: TASK_GRAPH_WORKFLOW_TYPE,
      })
    );
  }

  status(workflowId: string): Promise<WorkflowQueryResult> {
    return Promise.resolve(
      this.#workflows.query({ name: "status", workflowId })
    );
  }

  ready(workflowId: string): Promise<WorkflowQueryResult> {
    return Promise.resolve(
      this.#workflows.query({ name: "ready", workflowId })
    );
  }

  satisfyGate(
    command: TaskGraphMutationCommand
  ): Promise<WorkflowCommandReceipt> {
    return this.#signal("satisfy_gate", command);
  }

  claim(command: TaskGraphWorkerCommand): Promise<WorkflowCommandReceipt> {
    return this.#workerSignal("claim", command);
  }

  begin(command: TaskGraphWorkerCommand): Promise<WorkflowCommandReceipt> {
    return this.#workerSignal("start", command);
  }

  complete(command: TaskGraphMutationCommand): Promise<WorkflowCommandReceipt> {
    return this.#signal("complete", command);
  }

  fail(command: TaskGraphMutationCommand): Promise<WorkflowCommandReceipt> {
    return this.#signal("fail", command);
  }

  cancel(
    workflowId: string,
    requestId: string,
    reason: string
  ): Promise<WorkflowCommandReceipt> {
    return Promise.resolve(
      this.#workflows.cancel({ reason, requestId, workflowId })
    );
  }

  #workerSignal(
    name: "claim" | "start",
    command: TaskGraphWorkerCommand
  ): Promise<WorkflowCommandReceipt> {
    return this.#signal(name, {
      payload: { taskId: command.taskId, workerId: command.workerId },
      requestId: command.requestId,
      workflowId: command.workflowId,
    });
  }

  #signal(
    name: string,
    command: TaskGraphMutationCommand
  ): Promise<WorkflowCommandReceipt> {
    return Promise.resolve(
      this.#workflows.signal({
        name,
        payload: command.payload,
        requestId: command.requestId,
        workflowId: command.workflowId,
      })
    );
  }
}

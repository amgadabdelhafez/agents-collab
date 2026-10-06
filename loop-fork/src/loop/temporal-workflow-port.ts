import {
  type WorkflowClient,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowHandle,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  type TemporalWorkflowCommand,
  type TemporalWorkflowCommandOutcome,
  temporalCommandOutcomeQuery,
  temporalCommandSignal,
  temporalInspectionQuery,
  temporalPortQuery,
  temporalStartSnapshotQuery,
  temporalWorkflow,
} from "./temporal-workflow";
import {
  type WorkflowCancelCommand,
  type WorkflowCommandReceipt,
  WorkflowError,
  type WorkflowInspection,
  type WorkflowPort,
  type WorkflowPresence,
  type WorkflowQueryCommand,
  type WorkflowQueryResult,
  type WorkflowSignalCommand,
  type WorkflowStartCommand,
  type WorkflowStartReceipt,
} from "./workflow-port";

export interface TemporalWorkflowPortOptions {
  commandObservationAttempts?: number;
  commandObservationDelayMs?: number;
  now?: () => string;
  taskQueue: string;
}

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const TASK_QUEUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

export class TemporalWorkflowPort implements WorkflowPort {
  readonly #client: WorkflowClient;
  readonly #observationAttempts: number;
  readonly #observationDelayMs: number;
  readonly #now: () => string;
  readonly #taskQueue: string;

  constructor(client: unknown, options: TemporalWorkflowPortOptions) {
    if (
      typeof options.taskQueue !== "string" ||
      !TASK_QUEUE_RE.test(options.taskQueue)
    ) {
      throw new Error("Temporal workflow port taskQueue is invalid");
    }
    this.#client = client as WorkflowClient;
    this.#taskQueue = options.taskQueue;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#observationAttempts = options.commandObservationAttempts ?? 200;
    this.#observationDelayMs = options.commandObservationDelayMs ?? 5;
  }

  /** The deployment discriminator: the queue this port starts and adopts. */
  get taskQueue(): string {
    return this.#taskQueue;
  }

  cancel(command: WorkflowCancelCommand): Promise<WorkflowCommandReceipt> {
    return this.#command(command.workflowId, {
      at: this.#now(),
      kind: "cancel",
      reason: command.reason,
      requestId: command.requestId,
    });
  }

  inspect(workflowId: string): Promise<WorkflowInspection> {
    return this.#handle(workflowId).query(temporalInspectionQuery);
  }

  async isClosed(workflowId: string): Promise<boolean> {
    return (await this.presence(workflowId)) === "closed";
  }

  /**
   * Presence of this deployment's own execution. A same-ID execution on
   * another task queue is neither running nor closed for this port: it is a
   * conflict, so no caller can read, adopt or record a foreign outcome.
   */
  async presence(workflowId: string): Promise<WorkflowPresence> {
    let description: Awaited<ReturnType<WorkflowHandle["describe"]>>;
    try {
      description = await this.#handle(workflowId).describe();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return "missing";
      }
      throw error;
    }
    this.#requireOwnTaskQueue(workflowId, description.taskQueue);
    return description.status.name === "RUNNING" ? "running" : "closed";
  }

  query(command: WorkflowQueryCommand): Promise<WorkflowQueryResult> {
    return this.#handle(command.workflowId).query(
      temporalPortQuery,
      command.name,
      command.args
    );
  }

  signal(command: WorkflowSignalCommand): Promise<WorkflowCommandReceipt> {
    return this.#command(command.workflowId, {
      at: this.#now(),
      kind: "signal",
      name: command.name,
      payload: command.payload,
      requestId: command.requestId,
    });
  }

  async start(command: WorkflowStartCommand): Promise<WorkflowStartReceipt> {
    let created = true;
    let handle: WorkflowHandle;
    try {
      handle = await this.#client.start(temporalWorkflow, {
        args: [
          {
            at: this.#now(),
            input: command.input,
            requestId: command.requestId,
            workflowId: command.workflowId,
            workflowType: command.workflowType,
          },
        ],
        taskQueue: this.#taskQueue,
        workflowId: command.workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
      created = false;
      handle = this.#handle(command.workflowId);
      this.#requireOwnTaskQueue(
        command.workflowId,
        (await handle.describe()).taskQueue
      );
    }
    const snapshot = await handle.query(temporalStartSnapshotQuery);
    if (snapshot.inspection.workflowType !== command.workflowType) {
      throw new WorkflowError(
        "conflict",
        `workflow ${command.workflowId} already exists as ${snapshot.inspection.workflowType}`
      );
    }
    return {
      ...snapshot.startReceipt,
      created,
      replayed: !created && snapshot.startRequestId === command.requestId,
      revision: snapshot.inspection.revision,
      status: snapshot.inspection.status,
    };
  }

  async #command(
    workflowId: string,
    command: TemporalWorkflowCommand
  ): Promise<WorkflowCommandReceipt> {
    const handle = this.#handle(workflowId);
    const key = `${command.kind}:${command.requestId}`;
    const existing = await handle.query(temporalCommandOutcomeQuery, key);
    if (existing) {
      return this.#unwrap(existing, true);
    }
    await handle.signal(temporalCommandSignal, command);
    for (let attempt = 0; attempt < this.#observationAttempts; attempt += 1) {
      const outcome = await handle.query(temporalCommandOutcomeQuery, key);
      if (outcome) {
        return this.#unwrap(outcome, false);
      }
      await sleep(this.#observationDelayMs);
    }
    throw new WorkflowError(
      "invalid-state",
      `Temporal did not durably observe ${key} within the bounded wait`
    );
  }

  #handle(workflowId: string): WorkflowHandle {
    return this.#client.getHandle(workflowId);
  }

  /**
   * A workflow ID is unique per namespace, not per deployment. Another
   * deployment sharing the namespace under its own task queue can hold the
   * same ID; treating its execution as ours would read and signal foreign
   * state, or record its outcome as ours.
   */
  #requireOwnTaskQueue(workflowId: string, taskQueue: string): void {
    if (taskQueue !== this.#taskQueue) {
      throw new WorkflowError(
        "conflict",
        `workflow ${workflowId} belongs to another task queue`
      );
    }
  }

  #unwrap(
    outcome: TemporalWorkflowCommandOutcome,
    replayed: boolean
  ): WorkflowCommandReceipt {
    if (outcome.error) {
      throw new WorkflowError(outcome.error.code, outcome.error.message);
    }
    if (!outcome.receipt) {
      throw new WorkflowError(
        "invalid-state",
        "Temporal command outcome has neither receipt nor error"
      );
    }
    return { ...outcome.receipt, replayed };
  }
}

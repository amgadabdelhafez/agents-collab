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

export class TemporalWorkflowPort implements WorkflowPort {
  readonly #client: WorkflowClient;
  readonly #observationAttempts: number;
  readonly #observationDelayMs: number;
  readonly #now: () => string;
  readonly #taskQueue: string;

  constructor(client: unknown, options: TemporalWorkflowPortOptions) {
    this.#client = client as WorkflowClient;
    this.#taskQueue = options.taskQueue;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#observationAttempts = options.commandObservationAttempts ?? 200;
    this.#observationDelayMs = options.commandObservationDelayMs ?? 5;
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
    try {
      return (
        (await this.#handle(workflowId).describe()).status.name !== "RUNNING"
      );
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return false;
      }
      throw error;
    }
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

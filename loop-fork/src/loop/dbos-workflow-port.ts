import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  DBOS_COMMAND_TOPIC,
  DBOS_INSPECTION_EVENT,
  DBOS_START_EVENT,
  type DbosWorkflowCommand,
  type DbosWorkflowCommandOutcome,
  type DbosWorkflowSnapshot,
  dbosCommandEvent,
} from "./dbos-workflow";
import type {
  WorkflowCancelCommand,
  WorkflowCommandReceipt,
  WorkflowInspection,
  WorkflowPort,
  WorkflowQueryCommand,
  WorkflowQueryResult,
  WorkflowSignalCommand,
  WorkflowStartCommand,
  WorkflowStartReceipt,
} from "./workflow-port";
import { WorkflowError } from "./workflow-port";

export interface DbosWorkflowPortOptions {
  commandObservationSeconds?: number;
  now?: () => string;
  registeredWorkflow: unknown;
}

export class DbosWorkflowPort implements WorkflowPort {
  readonly #observationSeconds: number;
  readonly #now: () => string;
  readonly #registeredWorkflow: (input: unknown) => Promise<unknown>;

  constructor(options: DbosWorkflowPortOptions) {
    this.#registeredWorkflow = options.registeredWorkflow as (
      input: unknown
    ) => Promise<unknown>;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#observationSeconds = options.commandObservationSeconds ?? 2;
  }

  cancel(command: WorkflowCancelCommand): Promise<WorkflowCommandReceipt> {
    return this.#command(command.workflowId, {
      at: this.#now(),
      kind: "cancel",
      reason: command.reason,
      requestId: command.requestId,
    });
  }

  async inspect(workflowId: string): Promise<WorkflowInspection> {
    const value = await DBOS.getEvent<WorkflowInspection>(
      workflowId,
      DBOS_INSPECTION_EVENT,
      { timeoutSeconds: this.#observationSeconds, pollingIntervalMs: 5 }
    );
    if (!value) {
      throw new WorkflowError("not-found", `workflow ${workflowId} not found`);
    }
    return value;
  }

  async query(command: WorkflowQueryCommand): Promise<WorkflowQueryResult> {
    const key = `query-${randomUUID()}`;
    const message: DbosWorkflowCommand = {
      ...(command.args ? { args: command.args } : {}),
      key,
      kind: "query",
      name: command.name,
    };
    await DBOS.send(
      command.workflowId,
      message,
      DBOS_COMMAND_TOPIC,
      `workflow-port-${key}`
    );
    const outcome = await this.#outcome(command.workflowId, key);
    if (!outcome.query) {
      throw new WorkflowError(
        "invalid-state",
        `DBOS query ${key} returned no query result`
      );
    }
    return outcome.query;
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
    const previous = await DBOS.getWorkflowStatus(command.workflowId);
    if (previous === null) {
      await DBOS.startWorkflow(this.#registeredWorkflow, {
        workflowID: command.workflowId,
      })({
        at: this.#now(),
        input: command.input,
        requestId: command.requestId,
        workflowId: command.workflowId,
        workflowType: command.workflowType,
      });
    }
    const snapshot = await DBOS.getEvent<DbosWorkflowSnapshot>(
      command.workflowId,
      DBOS_START_EVENT,
      { timeoutSeconds: this.#observationSeconds, pollingIntervalMs: 5 }
    );
    if (!snapshot) {
      throw new WorkflowError(
        "invalid-state",
        `DBOS did not publish start state for ${command.workflowId}`
      );
    }
    if (snapshot.inspection.workflowType !== command.workflowType) {
      throw new WorkflowError(
        "conflict",
        `workflow ${command.workflowId} already exists as ${snapshot.inspection.workflowType}`
      );
    }
    const created = previous === null;
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
    command: Exclude<DbosWorkflowCommand, { kind: "query" }>
  ): Promise<WorkflowCommandReceipt> {
    const key = `${command.kind}-${command.requestId}`;
    const existing = await DBOS.getEvent<DbosWorkflowCommandOutcome>(
      workflowId,
      dbosCommandEvent(key),
      { timeoutSeconds: 0.01, pollingIntervalMs: 2 }
    );
    if (existing) {
      return this.#unwrap(existing, true);
    }
    await DBOS.send(
      workflowId,
      command,
      DBOS_COMMAND_TOPIC,
      `workflow-port-${key}`
    );
    return this.#unwrap(await this.#outcome(workflowId, key), false);
  }

  async #outcome(
    workflowId: string,
    key: string
  ): Promise<DbosWorkflowCommandOutcome> {
    const outcome = await DBOS.getEvent<DbosWorkflowCommandOutcome>(
      workflowId,
      dbosCommandEvent(key),
      {
        timeoutSeconds: this.#observationSeconds,
        pollingIntervalMs: 5,
      }
    );
    if (!outcome) {
      throw new WorkflowError(
        "invalid-state",
        `DBOS did not durably observe ${key} within the bounded wait`
      );
    }
    if (outcome.error) {
      throw new WorkflowError(outcome.error.code, outcome.error.message);
    }
    return outcome;
  }

  #unwrap(
    outcome: DbosWorkflowCommandOutcome,
    replayed: boolean
  ): WorkflowCommandReceipt {
    if (outcome.error) {
      throw new WorkflowError(outcome.error.code, outcome.error.message);
    }
    if (!outcome.receipt) {
      throw new WorkflowError(
        "invalid-state",
        "DBOS command outcome has neither receipt nor error"
      );
    }
    return { ...outcome.receipt, replayed };
  }
}

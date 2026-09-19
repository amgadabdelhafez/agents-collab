/*
 * RETIRED (gov-6).
 * Replacement: the governess beat now runs as the governess-beat.v1
 * WorkflowDefinition on Temporal, driven by the generic host workflow in
 * ./temporal-workflow.ts; replay is Temporal replay and the journal is a read
 * model exported from workflow history.
 * Left in place deliberately: deletion is the gov-7 cutover's job, not this
 * slice's. Unwired here, not removed.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { supervisorMessageWorkflowDefinition } from "./supervisor-message-workflow";
import type {
  JsonObject,
  WorkflowCommandReceipt,
  WorkflowErrorCode,
  WorkflowEvent,
  WorkflowExecutionStatus,
  WorkflowInspection,
  WorkflowQueryResult,
  WorkflowStartReceipt,
} from "./workflow-port";
import { WorkflowError } from "./workflow-port";

export interface DbosWorkflowStartInput {
  at: string;
  input: JsonObject;
  requestId: string;
  workflowId: string;
  workflowType: string;
}

export type DbosWorkflowCommand =
  | {
      at: string;
      kind: "signal";
      name: string;
      payload: JsonObject;
      requestId: string;
    }
  | {
      at: string;
      kind: "cancel";
      reason: string;
      requestId: string;
    }
  | {
      args?: JsonObject;
      key: string;
      kind: "query";
      name: string;
    };

export interface DbosWorkflowCommandError {
  code: WorkflowErrorCode;
  message: string;
}

export interface DbosWorkflowCommandOutcome {
  error?: DbosWorkflowCommandError;
  query?: WorkflowQueryResult;
  receipt?: WorkflowCommandReceipt;
}

export interface DbosWorkflowSnapshot {
  inspection: WorkflowInspection;
  startReceipt: WorkflowStartReceipt;
  startRequestId: string;
}

export const DBOS_COMMAND_TOPIC = "workflow-port-command";
export const DBOS_INSPECTION_EVENT = "workflow-port-inspection";
export const DBOS_START_EVENT = "workflow-port-start";
export const dbosCommandEvent = (key: string): string =>
  `workflow-port-command-${key}`;

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
const receiptKey = (kind: "cancel" | "signal", requestId: string): string =>
  `${kind}-${requestId}`;

const errorOf = (error: unknown): DbosWorkflowCommandError => {
  if (error instanceof WorkflowError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "invalid-state",
    message: error instanceof Error ? error.message : "workflow command failed",
  };
};

interface DbosWorkflowState {
  history: WorkflowEvent[];
  revision: number;
  state: JsonObject;
  status: WorkflowExecutionStatus;
  updatedAt: string;
}

const inspectionOf = (
  input: DbosWorkflowStartInput,
  current: DbosWorkflowState
): WorkflowInspection => ({
  createdAt: input.at,
  history: clone(current.history),
  revision: current.revision,
  status: current.status,
  updatedAt: current.updatedAt,
  workflowId: input.workflowId,
  workflowType: input.workflowType,
});

const queryOutcome = (
  input: DbosWorkflowStartInput,
  current: DbosWorkflowState,
  command: Extract<DbosWorkflowCommand, { kind: "query" }>
): DbosWorkflowCommandOutcome => {
  try {
    return {
      query: {
        revision: current.revision,
        status: current.status,
        value: clone(
          supervisorMessageWorkflowDefinition.query(
            clone(current.state),
            command.name,
            command.args ? clone(command.args) : undefined
          )
        ),
        workflowId: input.workflowId,
      },
    };
  } catch (error) {
    return { error: errorOf(error) };
  }
};

interface AppliedDbosCommand {
  changed: boolean;
  outcome: DbosWorkflowCommandOutcome;
}

const applyCommand = (
  input: DbosWorkflowStartInput,
  current: DbosWorkflowState,
  command: Exclude<DbosWorkflowCommand, { kind: "query" }>
): AppliedDbosCommand => {
  if (current.status === "canceled" && command.kind === "cancel") {
    return {
      changed: false,
      outcome: {
        receipt: {
          replayed: false,
          revision: current.revision,
          status: current.status,
          workflowId: input.workflowId,
        },
      },
    };
  }
  try {
    if (current.status !== "running") {
      throw new WorkflowError(
        "invalid-state",
        `cannot ${command.kind} workflow ${input.workflowId} in ${current.status}`
      );
    }
    const nextRevision = current.revision + 1;
    const transition =
      command.kind === "signal"
        ? supervisorMessageWorkflowDefinition.signal(
            clone(current.state),
            command.name,
            clone(command.payload),
            {
              at: command.at,
              nextRevision,
              requestId: command.requestId,
              workflowId: input.workflowId,
            }
          )
        : supervisorMessageWorkflowDefinition.cancel(
            clone(current.state),
            command.reason,
            {
              at: command.at,
              nextRevision,
              requestId: command.requestId,
              workflowId: input.workflowId,
            }
          );
    const nextStatus =
      transition.status ??
      (command.kind === "cancel" ? "canceled" : current.status);
    const changed = transition.changed !== false;
    if (changed) {
      current.revision = nextRevision;
      current.state = clone(transition.state);
      current.status = nextStatus;
      current.updatedAt = command.at;
      current.history.push({
        at: command.at,
        kind: command.kind === "cancel" ? "canceled" : "signaled",
        name: command.kind === "cancel" ? "cancel" : command.name,
        requestId: command.requestId,
        revision: current.revision,
        sequence: current.history.length + 1,
      });
    }
    return {
      changed,
      outcome: {
        receipt: {
          replayed: false,
          ...(transition.result === undefined
            ? {}
            : { result: clone(transition.result) }),
          revision: current.revision,
          status: current.status,
          workflowId: input.workflowId,
        },
      },
    };
  } catch (error) {
    return { changed: false, outcome: { error: errorOf(error) } };
  }
};

export async function dbosWorkflowFunction(
  input: DbosWorkflowStartInput
): Promise<never> {
  if (input.workflowType !== supervisorMessageWorkflowDefinition.type) {
    throw new WorkflowError(
      "unknown-workflow-type",
      `unknown workflow type ${input.workflowType}`
    );
  }
  const started = supervisorMessageWorkflowDefinition.start(input.input, {
    at: input.at,
    nextRevision: 1,
    requestId: input.requestId,
    workflowId: input.workflowId,
  });
  const current: DbosWorkflowState = {
    history: [
      {
        at: input.at,
        kind: "started",
        name: input.workflowType,
        requestId: input.requestId,
        revision: 1,
        sequence: 1,
      },
    ],
    revision: 1,
    state: clone(started.state),
    status: started.status ?? "running",
    updatedAt: input.at,
  };
  const outcomes = new Map<string, DbosWorkflowCommandOutcome>();
  const startReceipt: WorkflowStartReceipt = {
    created: true,
    replayed: false,
    ...(started.result === undefined ? {} : { result: clone(started.result) }),
    revision: current.revision,
    status: current.status,
    workflowId: input.workflowId,
    workflowType: input.workflowType,
  };
  const publishInspection = async (): Promise<void> => {
    await DBOS.setEvent(DBOS_INSPECTION_EVENT, inspectionOf(input, current));
  };

  await DBOS.setEvent(DBOS_START_EVENT, {
    inspection: inspectionOf(input, current),
    startReceipt,
    startRequestId: input.requestId,
  } satisfies DbosWorkflowSnapshot);
  await publishInspection();

  while (true) {
    const command = await DBOS.recv<DbosWorkflowCommand>(DBOS_COMMAND_TOPIC, {
      timeoutSeconds: 3600,
    });
    if (!command) {
      continue;
    }
    if (command.kind === "query") {
      await DBOS.setEvent(
        dbosCommandEvent(command.key),
        queryOutcome(input, current, command)
      );
      continue;
    }

    const key = receiptKey(command.kind, command.requestId);
    const previous = outcomes.get(key);
    if (previous) {
      await DBOS.setEvent(dbosCommandEvent(key), previous);
      continue;
    }
    const applied = applyCommand(input, current, command);
    if (applied.changed) {
      await publishInspection();
    }
    outcomes.set(key, applied.outcome);
    await DBOS.setEvent(dbosCommandEvent(key), applied.outcome);
  }
}

export const registerDbosWorkflow = () =>
  DBOS.registerWorkflow(dbosWorkflowFunction, {
    name: "supervisorMessageWorkflowPort",
    serialization: "portable",
  });

import {
  condition,
  defineQuery,
  defineSignal,
  setHandler,
} from "@temporalio/workflow";
import { governessBeatWorkflowDefinition } from "./governess-beat-workflow";
import { supervisorMessageWorkflowDefinition } from "./supervisor-message-workflow";
import { taskGraphWorkflowDefinition } from "./task-graph-workflow";
import type {
  JsonObject,
  WorkflowCommandReceipt,
  WorkflowDefinition,
  WorkflowErrorCode,
  WorkflowEvent,
  WorkflowExecutionStatus,
  WorkflowInspection,
  WorkflowQueryResult,
  WorkflowStartReceipt,
} from "./workflow-port";
import { WorkflowError } from "./workflow-port";

export interface TemporalWorkflowStartInput {
  at: string;
  input: JsonObject;
  requestId: string;
  workflowId: string;
  workflowType: string;
}

export type TemporalWorkflowCommand =
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
    };

export interface TemporalWorkflowCommandError {
  code: WorkflowErrorCode;
  message: string;
}

export interface TemporalWorkflowCommandOutcome {
  error?: TemporalWorkflowCommandError;
  receipt?: WorkflowCommandReceipt;
}

export interface TemporalWorkflowSnapshot {
  inspection: WorkflowInspection;
  startReceipt: WorkflowStartReceipt;
  startRequestId: string;
}

export const temporalCommandSignal = defineSignal<[TemporalWorkflowCommand]>(
  "workflow-port-command"
);
export const temporalCommandOutcomeQuery = defineQuery<
  TemporalWorkflowCommandOutcome | undefined,
  [string]
>("workflow-port-command-outcome");
export const temporalInspectionQuery = defineQuery<WorkflowInspection>(
  "workflow-port-inspection"
);
export const temporalPortQuery = defineQuery<
  WorkflowQueryResult,
  [string, JsonObject | undefined]
>("workflow-port-query");
export const temporalStartSnapshotQuery = defineQuery<TemporalWorkflowSnapshot>(
  "workflow-port-start-snapshot"
);

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
const receiptKey = (kind: "cancel" | "signal", requestId: string): string =>
  `${kind}:${requestId}`;

const WORKFLOW_DEFINITIONS = new Map<string, WorkflowDefinition>(
  [
    governessBeatWorkflowDefinition,
    supervisorMessageWorkflowDefinition,
    taskGraphWorkflowDefinition,
  ].map((definition) => [definition.type, definition])
);

const errorOf = (error: unknown): TemporalWorkflowCommandError => {
  if (error instanceof WorkflowError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "invalid-state",
    message: error instanceof Error ? error.message : "workflow command failed",
  };
};

interface AppliedTemporalCommand {
  event?: Omit<WorkflowEvent, "revision" | "sequence">;
  outcome: TemporalWorkflowCommandOutcome;
  state?: JsonObject;
  status?: WorkflowExecutionStatus;
}

const applyCommand = (
  definition: WorkflowDefinition,
  state: JsonObject,
  status: WorkflowExecutionStatus,
  workflowId: string,
  revision: number,
  command: TemporalWorkflowCommand
): AppliedTemporalCommand => {
  if (status === "canceled" && command.kind === "cancel") {
    return {
      outcome: {
        receipt: {
          replayed: false,
          revision,
          status,
          workflowId,
        },
      },
    };
  }
  if (status !== "running") {
    return {
      outcome: {
        error: {
          code: "invalid-state",
          message: `cannot ${command.kind} workflow ${workflowId} in ${status}`,
        },
      },
    };
  }
  try {
    const nextRevision = revision + 1;
    const transition =
      command.kind === "signal"
        ? definition.signal(
            clone(state),
            command.name,
            clone(command.payload),
            {
              at: command.at,
              nextRevision,
              requestId: command.requestId,
              workflowId,
            }
          )
        : definition.cancel(clone(state), command.reason, {
            at: command.at,
            nextRevision,
            requestId: command.requestId,
            workflowId,
          });
    const nextStatus =
      transition.status ?? (command.kind === "cancel" ? "canceled" : status);
    return {
      ...(transition.changed === false
        ? {}
        : {
            event: {
              at: command.at,
              kind: command.kind === "cancel" ? "canceled" : "signaled",
              name: command.kind === "cancel" ? "cancel" : command.name,
              requestId: command.requestId,
            },
            state: clone(transition.state),
            status: nextStatus,
          }),
      outcome: {
        receipt: {
          replayed: false,
          ...(transition.result === undefined
            ? {}
            : { result: clone(transition.result) }),
          revision: transition.changed === false ? revision : nextRevision,
          status: transition.changed === false ? status : nextStatus,
          workflowId,
        },
      },
    };
  } catch (error) {
    return { outcome: { error: errorOf(error) } };
  }
};

export async function temporalWorkflow(
  input: TemporalWorkflowStartInput
): Promise<never> {
  const definition = WORKFLOW_DEFINITIONS.get(input.workflowType);
  if (!definition) {
    throw new WorkflowError(
      "unknown-workflow-type",
      `unknown workflow type ${input.workflowType}`
    );
  }
  const started = definition.start(input.input, {
    at: input.at,
    nextRevision: 1,
    requestId: input.requestId,
    workflowId: input.workflowId,
  });
  let state = clone(started.state);
  let status: WorkflowExecutionStatus = started.status ?? "running";
  let revision = 1;
  let updatedAt = input.at;
  const history: WorkflowEvent[] = [
    {
      at: input.at,
      kind: "started",
      name: input.workflowType,
      requestId: input.requestId,
      revision: 1,
      sequence: 1,
    },
  ];
  const outcomes = new Map<string, TemporalWorkflowCommandOutcome>();
  const startReceipt: WorkflowStartReceipt = {
    created: true,
    replayed: false,
    ...(started.result === undefined ? {} : { result: clone(started.result) }),
    revision: 1,
    status,
    workflowId: input.workflowId,
    workflowType: input.workflowType,
  };

  const inspection = (): WorkflowInspection => ({
    createdAt: input.at,
    history: clone(history),
    revision,
    status,
    updatedAt,
    workflowId: input.workflowId,
    workflowType: input.workflowType,
  });

  setHandler(temporalCommandOutcomeQuery, (key) => clone(outcomes.get(key)));
  setHandler(temporalInspectionQuery, () => inspection());
  setHandler(temporalStartSnapshotQuery, () => ({
    inspection: inspection(),
    startRequestId: input.requestId,
    startReceipt: clone(startReceipt),
  }));
  setHandler(temporalPortQuery, (name, args) => ({
    revision,
    status,
    value: clone(
      definition.query(clone(state), name, args ? clone(args) : undefined)
    ),
    workflowId: input.workflowId,
  }));
  setHandler(temporalCommandSignal, (command) => {
    const key = receiptKey(command.kind, command.requestId);
    if (outcomes.has(key)) {
      return;
    }
    const applied = applyCommand(
      definition,
      state,
      status,
      input.workflowId,
      revision,
      command
    );
    if (applied.event && applied.state && applied.status) {
      revision += 1;
      state = applied.state;
      status = applied.status;
      updatedAt = command.at;
      history.push({
        ...applied.event,
        revision,
        sequence: history.length + 1,
      });
    }
    outcomes.set(key, applied.outcome);
  });

  await condition(() => false);
  throw new Error("unreachable");
}

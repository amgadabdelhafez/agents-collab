export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type WorkflowExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowEventKind = "started" | "signaled" | "canceled";

export interface WorkflowEvent {
  at: string;
  kind: WorkflowEventKind;
  name: string;
  requestId: string;
  revision: number;
  sequence: number;
}

export interface WorkflowStartCommand {
  input: JsonObject;
  requestId: string;
  workflowId: string;
  workflowType: string;
}

export interface WorkflowSignalCommand {
  name: string;
  payload: JsonObject;
  requestId: string;
  workflowId: string;
}

export interface WorkflowQueryCommand {
  args?: JsonObject;
  name: string;
  workflowId: string;
}

export interface WorkflowCancelCommand {
  reason: string;
  requestId: string;
  workflowId: string;
}

export interface WorkflowCommandReceipt {
  replayed: boolean;
  result?: JsonValue;
  revision: number;
  status: WorkflowExecutionStatus;
  workflowId: string;
}

export interface WorkflowStartReceipt extends WorkflowCommandReceipt {
  created: boolean;
  workflowType: string;
}

export interface WorkflowQueryResult {
  revision: number;
  status: WorkflowExecutionStatus;
  value: JsonValue;
  workflowId: string;
}

export interface WorkflowInspection {
  createdAt: string;
  history: readonly WorkflowEvent[];
  revision: number;
  status: WorkflowExecutionStatus;
  updatedAt: string;
  workflowId: string;
  workflowType: string;
}

export type WorkflowResult<T> = Promise<T> | T;

/**
 * Whether the engine still holds an execution. `missing` is distinct from
 * `closed`: an engine may purge a closed execution after its retention period,
 * and an execution whose start never happened is missing too.
 */
export type WorkflowPresence = "closed" | "missing" | "running";

export interface WorkflowPort {
  cancel(
    command: WorkflowCancelCommand
  ): WorkflowResult<WorkflowCommandReceipt>;
  inspect(workflowId: string): WorkflowResult<WorkflowInspection>;
  isClosed?(workflowId: string): WorkflowResult<boolean>;
  presence?(workflowId: string): WorkflowResult<WorkflowPresence>;
  query(command: WorkflowQueryCommand): WorkflowResult<WorkflowQueryResult>;
  signal(
    command: WorkflowSignalCommand
  ): WorkflowResult<WorkflowCommandReceipt>;
  start(command: WorkflowStartCommand): WorkflowResult<WorkflowStartReceipt>;
}

export type WorkflowErrorCode =
  | "conflict"
  | "invalid-command"
  | "invalid-state"
  | "not-found"
  | "unknown-query"
  | "unknown-signal"
  | "unknown-workflow-type";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export interface WorkflowTransitionContext {
  at: string;
  nextRevision: number;
  requestId: string;
  workflowId: string;
}

export interface WorkflowStartResult {
  result?: JsonValue;
  state: JsonObject;
  status?: WorkflowExecutionStatus;
}

export interface WorkflowTransitionResult {
  changed?: boolean;
  result?: JsonValue;
  state: JsonObject;
  status?: WorkflowExecutionStatus;
}

export interface WorkflowDefinition {
  cancel(
    state: JsonObject,
    reason: string,
    context: WorkflowTransitionContext
  ): WorkflowTransitionResult;
  query(state: JsonObject, name: string, args?: JsonObject): JsonValue;
  signal(
    state: JsonObject,
    name: string,
    payload: JsonObject,
    context: WorkflowTransitionContext
  ): WorkflowTransitionResult;
  start(
    input: JsonObject,
    context: WorkflowTransitionContext
  ): WorkflowStartResult;
  type: string;
}

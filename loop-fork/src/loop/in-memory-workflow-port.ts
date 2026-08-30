import {
  type JsonObject,
  type JsonValue,
  type WorkflowCancelCommand,
  type WorkflowCommandReceipt,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowEvent,
  type WorkflowExecutionStatus,
  type WorkflowInspection,
  type WorkflowPort,
  type WorkflowQueryCommand,
  type WorkflowQueryResult,
  type WorkflowSignalCommand,
  type WorkflowStartCommand,
  type WorkflowStartReceipt,
  type WorkflowTransitionContext,
} from "./workflow-port";

interface StoredWorkflow {
  commandReceipts: Map<string, WorkflowCommandReceipt>;
  createdAt: string;
  definition: WorkflowDefinition;
  history: WorkflowEvent[];
  revision: number;
  startRequestId: string;
  state: JsonObject;
  status: WorkflowExecutionStatus;
  updatedAt: string;
  workflowId: string;
}

export interface InMemoryWorkflowPortOptions {
  definitions: readonly WorkflowDefinition[];
  now?: () => string;
}

const TERMINAL_STATUSES = new Set<WorkflowExecutionStatus>([
  "completed",
  "failed",
  "canceled",
]);

const clone = <T>(value: T): T => structuredClone(value);

const requireNonEmpty = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new WorkflowError("invalid-command", `${field} must be non-empty`);
  }
  return normalized;
};

const receiptKey = (kind: "cancel" | "signal", requestId: string): string =>
  `${kind}:${requestId}`;

export class InMemoryWorkflowPort implements WorkflowPort {
  readonly #definitions: Map<string, WorkflowDefinition>;
  readonly #now: () => string;
  readonly #workflows = new Map<string, StoredWorkflow>();

  constructor(options: InMemoryWorkflowPortOptions) {
    this.#definitions = new Map(
      options.definitions.map((definition) => [definition.type, definition])
    );
    if (this.#definitions.size !== options.definitions.length) {
      throw new WorkflowError(
        "conflict",
        "workflow definitions must have unique type names"
      );
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  start(command: WorkflowStartCommand): WorkflowStartReceipt {
    const workflowId = requireNonEmpty(command.workflowId, "workflowId");
    const workflowType = requireNonEmpty(command.workflowType, "workflowType");
    const requestId = requireNonEmpty(command.requestId, "requestId");
    const existing = this.#workflows.get(workflowId);
    if (existing) {
      if (existing.definition.type !== workflowType) {
        throw new WorkflowError(
          "conflict",
          `workflow ${workflowId} already exists as ${existing.definition.type}`
        );
      }
      return {
        created: false,
        replayed: existing.startRequestId === requestId,
        revision: existing.revision,
        status: existing.status,
        workflowId,
        workflowType,
      };
    }
    const definition = this.#definitions.get(workflowType);
    if (!definition) {
      throw new WorkflowError(
        "unknown-workflow-type",
        `unknown workflow type ${workflowType}`
      );
    }
    const at = this.#now();
    const context: WorkflowTransitionContext = {
      at,
      nextRevision: 1,
      requestId,
      workflowId,
    };
    const started = definition.start(clone(command.input), context);
    const status = started.status ?? "running";
    const event: WorkflowEvent = {
      at,
      kind: "started",
      name: workflowType,
      requestId,
      revision: 1,
      sequence: 1,
    };
    this.#workflows.set(workflowId, {
      commandReceipts: new Map(),
      createdAt: at,
      definition,
      history: [event],
      revision: 1,
      startRequestId: requestId,
      state: clone(started.state),
      status,
      updatedAt: at,
      workflowId,
    });
    return {
      created: true,
      replayed: false,
      ...(started.result === undefined
        ? {}
        : { result: clone(started.result) }),
      revision: 1,
      status,
      workflowId,
      workflowType,
    };
  }

  signal(command: WorkflowSignalCommand): WorkflowCommandReceipt {
    const workflow = this.#requireWorkflow(command.workflowId);
    const requestId = requireNonEmpty(command.requestId, "requestId");
    const name = requireNonEmpty(command.name, "signal name");
    const key = receiptKey("signal", requestId);
    const replay = workflow.commandReceipts.get(key);
    if (replay) {
      return { ...clone(replay), replayed: true };
    }
    this.#assertRunning(workflow, `signal ${name}`);
    const at = this.#now();
    const nextRevision = workflow.revision + 1;
    const transition = workflow.definition.signal(
      clone(workflow.state),
      name,
      clone(command.payload),
      { at, nextRevision, requestId, workflowId: workflow.workflowId }
    );
    const receipt = this.#commit(
      workflow,
      transition.state,
      transition.status ?? workflow.status,
      { at, kind: "signaled", name, requestId },
      transition.result
    );
    workflow.commandReceipts.set(key, clone(receipt));
    return receipt;
  }

  query(command: WorkflowQueryCommand): WorkflowQueryResult {
    const workflow = this.#requireWorkflow(command.workflowId);
    const name = requireNonEmpty(command.name, "query name");
    return {
      revision: workflow.revision,
      status: workflow.status,
      value: clone(
        workflow.definition.query(
          clone(workflow.state),
          name,
          command.args ? clone(command.args) : undefined
        )
      ),
      workflowId: workflow.workflowId,
    };
  }

  cancel(command: WorkflowCancelCommand): WorkflowCommandReceipt {
    const workflow = this.#requireWorkflow(command.workflowId);
    const requestId = requireNonEmpty(command.requestId, "requestId");
    const reason = requireNonEmpty(command.reason, "reason");
    const key = receiptKey("cancel", requestId);
    const replay = workflow.commandReceipts.get(key);
    if (replay) {
      return { ...clone(replay), replayed: true };
    }
    if (workflow.status === "canceled") {
      const receipt: WorkflowCommandReceipt = {
        replayed: false,
        revision: workflow.revision,
        status: workflow.status,
        workflowId: workflow.workflowId,
      };
      workflow.commandReceipts.set(key, clone(receipt));
      return receipt;
    }
    this.#assertRunning(workflow, "cancel");
    const at = this.#now();
    const nextRevision = workflow.revision + 1;
    const transition = workflow.definition.cancel(
      clone(workflow.state),
      reason,
      { at, nextRevision, requestId, workflowId: workflow.workflowId }
    );
    const receipt = this.#commit(
      workflow,
      transition.state,
      transition.status ?? "canceled",
      { at, kind: "canceled", name: "cancel", requestId },
      transition.result
    );
    workflow.commandReceipts.set(key, clone(receipt));
    return receipt;
  }

  inspect(workflowId: string): WorkflowInspection {
    const workflow = this.#requireWorkflow(workflowId);
    return clone({
      createdAt: workflow.createdAt,
      history: workflow.history,
      revision: workflow.revision,
      status: workflow.status,
      updatedAt: workflow.updatedAt,
      workflowId: workflow.workflowId,
      workflowType: workflow.definition.type,
    });
  }

  #requireWorkflow(workflowId: string): StoredWorkflow {
    const normalized = requireNonEmpty(workflowId, "workflowId");
    const workflow = this.#workflows.get(normalized);
    if (!workflow) {
      throw new WorkflowError("not-found", `workflow ${normalized} not found`);
    }
    return workflow;
  }

  #assertRunning(workflow: StoredWorkflow, operation: string): void {
    if (TERMINAL_STATUSES.has(workflow.status)) {
      throw new WorkflowError(
        "invalid-state",
        `cannot ${operation} workflow ${workflow.workflowId} in ${workflow.status}`
      );
    }
  }

  #commit(
    workflow: StoredWorkflow,
    state: JsonObject,
    status: WorkflowExecutionStatus,
    event: Omit<WorkflowEvent, "revision" | "sequence">,
    result?: JsonValue
  ): WorkflowCommandReceipt {
    const revision = workflow.revision + 1;
    workflow.state = clone(state);
    workflow.status = status;
    workflow.revision = revision;
    workflow.updatedAt = event.at;
    workflow.history.push({
      ...event,
      revision,
      sequence: workflow.history.length + 1,
    });
    return {
      replayed: false,
      ...(result === undefined ? {} : { result: clone(result) }),
      revision,
      status,
      workflowId: workflow.workflowId,
    };
  }
}

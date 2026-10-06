import {
  deriveSupervisorMessageV2DeliveryId,
  parseSupervisorMessageV2Input,
  parseSupervisorMessageV2Projection,
  parseSupervisorMessageV2State,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  type SupervisorMessageV2Projection,
  type SupervisorMessageV2State,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  type SupervisorMessageInput,
  supervisorMessageWorkflowDefinition,
} from "./supervisor-message-workflow";
import {
  type JsonObject,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowPort,
  type WorkflowPresence,
  type WorkflowTransitionResult,
} from "./workflow-port";

export const SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE = "supervisor-message.v2";
const DISPATCH_OWNER = /^v2-dispatcher:[A-Za-z0-9._:-]{1,255}$/;

/**
 * A recorded terminal outcome closes a V2 workflow for good: recovery and
 * sender retries never start it again, and the ledger refuses to claim any
 * of its deliveries. `acknowledged` is the recipient's delivery/read
 * acknowledgement, deliberately not named completion: it says nothing about
 * the underlying work. `exhausted` is a message that ended undelivered on its
 * last allowed attempt, whatever that attempt's failure kind. `terminated` is
 * an execution the engine closed while its message phase was still open (an
 * operator terminate, an engine-level cancel, or a timeout).
 */
export const SUPERVISOR_MESSAGE_V2_TERMINAL_OUTCOMES = [
  "acknowledged",
  "canceled",
  "dead-lettered",
  "exhausted",
  "terminated",
] as const;
export type SupervisorMessageV2TerminalOutcome =
  (typeof SUPERVISOR_MESSAGE_V2_TERMINAL_OUTCOMES)[number];

export type SupervisorMessageV2DeliveryOutcome =
  | { status: "accepted" }
  | { reason: string; status: "permanent-failure" | "transient-failure" };

export interface SupervisorMessageV2DeliveryPort {
  deliver(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorMessageV2DeliveryOutcome>;
}

/**
 * The delivery boundary asks the control plane for the current, route-scoped
 * provider-session readiness immediately before it attempts an external
 * effect.  The receipt is intentionally opaque here: workflow state retains
 * no endpoint, session, provider credential, or provider-specific transcript.
 */
export interface SupervisorMessageV2DeliveryReadinessPort {
  assertReady(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<unknown> | unknown;
}

/**
 * A readiness port throws this when it cannot answer at all (its own store is
 * unreachable), as opposed to answering "this seat is not ready". The message
 * is fixed and opaque: no database URL, driver detail, or session detail.
 */
export class SupervisorMessageV2ReadinessUnavailableError extends Error {
  constructor() {
    super("session readiness store is unavailable");
    this.name = "SupervisorMessageV2ReadinessUnavailableError";
  }
}

/**
 * Explicit lifecycle hook for a V2-capable service. It intentionally keeps
 * recovery out of the sender request path: service startup performs one
 * durable sweep, and the configured period handles abandoned pre-dispatch and
 * post-effect records. A caller must opt in and own its shutdown lifecycle.
 */
export interface SupervisorMessageV2RecoveryPort {
  recoverPending(
    report?: (failure: SupervisorMessageV2RecoveryFailure) => void
  ): Promise<number>;
}

/** One recorded start that a recovery sweep could not recover. */
export interface SupervisorMessageV2RecoveryFailure {
  error: unknown;
  recipient: string;
  workflowId: string;
}

const recoveryFailureText = (error: unknown): string => {
  if (error instanceof WorkflowError) {
    return `WorkflowError (${error.code}): ${error.message}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : "unknown error";
};

export interface SupervisorMessageV2RecoveryRunnerOptions {
  coordinator: SupervisorMessageV2RecoveryPort;
  intervalMs: number;
  log?: (message: string) => void;
  timer?: SupervisorMessageV2RecoveryTimer;
}

export interface SupervisorMessageV2RecoveryTimer {
  clearInterval(timer: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
}

export interface SupervisorMessageV2RecoveryLifecycle {
  close(): Promise<void>;
  start(): Promise<void>;
}

const SYSTEM_RECOVERY_TIMER: SupervisorMessageV2RecoveryTimer = {
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>);
  },
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
};

export class SupervisorMessageV2RecoveryRunner
  implements SupervisorMessageV2RecoveryLifecycle
{
  readonly #coordinator: SupervisorMessageV2RecoveryPort;
  readonly #intervalMs: number;
  readonly #log: (message: string) => void;
  /** workflowId -> the line last logged for it, so a sweep repeats nothing. */
  readonly #reportedSkips = new Map<string, string>();
  readonly #timerPort: SupervisorMessageV2RecoveryTimer;
  #closed = false;
  #inFlight: Promise<number> | undefined;
  #starting: Promise<void> | undefined;
  #timer: unknown;

  constructor(options: SupervisorMessageV2RecoveryRunnerOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1000 ||
      options.intervalMs > 3_600_000
    ) {
      throw new Error("V2 recovery interval is invalid");
    }
    this.#coordinator = options.coordinator;
    this.#intervalMs = options.intervalMs;
    this.#log = options.log ?? ((message) => console.error(message));
    this.#timerPort = options.timer ?? SYSTEM_RECOVERY_TIMER;
  }

  async start(): Promise<void> {
    if (this.#closed) {
      throw new Error("V2 recovery runner is closed");
    }
    if (!this.#starting) {
      this.#starting = this.#start();
    }
    await this.#starting;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      this.#timerPort.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#starting?.catch(() => undefined);
    await this.#inFlight?.catch(() => undefined);
  }

  async sweep(): Promise<number> {
    if (this.#closed) {
      return 0;
    }
    if (this.#inFlight) {
      return 0;
    }
    // A record that cannot be recovered (for example an ID another
    // deployment's execution holds) is skipped and reported here, so it
    // degrades only that message's recipient: it neither refuses service
    // start nor stops recovery of every other record.
    const skipped = new Map<string, string>();
    const run = this.#coordinator.recoverPending((failure) => {
      skipped.set(
        failure.workflowId,
        `V2 recovery skipped workflow ${failure.workflowId} for ${failure.recipient}: ${recoveryFailureText(failure.error)}`
      );
    });
    this.#inFlight = run;
    try {
      const recovered = await run;
      for (const workflowId of this.#reportedSkips.keys()) {
        if (!skipped.has(workflowId)) {
          this.#reportedSkips.delete(workflowId);
        }
      }
      for (const [workflowId, line] of skipped) {
        if (this.#reportedSkips.get(workflowId) !== line) {
          this.#reportedSkips.set(workflowId, line);
          this.#log(line);
        }
      }
      return recovered;
    } finally {
      if (this.#inFlight === run) {
        this.#inFlight = undefined;
      }
    }
  }

  async #start(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      // A restarted worker must remain alive to recover a previously failing
      // workflow task. Killing it on the first Temporal query failure creates
      // a startup/recovery deadlock. Other failures still refuse startup.
      if (error instanceof WorkflowError && error.code === "conflict") {
        // The sweep already recovered every other intent. An ID held by
        // another deployment stays held until that execution is purged, so
        // refusing startup would let a foreign deployment keep this host down.
        this.#log(
          "V2 initial recovery deferred an intent held by another deployment"
        );
      } else if (
        !(error instanceof Error) ||
        (error.name !== "QueryFailedError" && error.name !== "ServiceError")
      ) {
        throw error;
      } else {
        this.#log("V2 initial recovery awaiting Temporal query retry");
      }
    }
    if (this.#closed) {
      return;
    }
    this.#timer = this.#timerPort.setInterval(() => {
      this.sweep().catch((error) => {
        this.#log(
          `V2 delivery recovery sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`
        );
      });
    }, this.#intervalMs);
  }
}

/**
 * Reopenable effect ledger for the external delivery boundary. Temporal owns
 * workflow state; this ledger owns only whether a canonical delivery ID was
 * prepared or externally completed, so a worker retry never repeats an
 * acknowledged external effect.
 */
export interface SupervisorMessageV2DeliveryLedger {
  assertStartIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<void>;
  claim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    now: Date,
    leaseMs: number
  ): Promise<{
    fence: number;
    state: "busy" | "claimed" | "closed" | "succeeded";
  }>;
  complete(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<void>;
  completeClaim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    fence: number
  ): Promise<void>;
  /**
   * The deployment discriminator this ledger mints workflow ids for: the
   * Temporal task queue of the host that owns it.
   */
  readonly deployment: string;
  /** Whether any delivery of this scoped workflow was externally completed. */
  hasCompletedDelivery(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<boolean>;
  prepare(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<"new" | "succeeded">;
  recordStartIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input
  ): Promise<SupervisorMessageV2Input>;
  /**
   * Durably marks the scoped workflow closed with its first observed terminal
   * outcome. A later, different outcome does not replace it.
   */
  recordTerminalOutcome(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope,
    outcome: SupervisorMessageV2TerminalOutcome
  ): Promise<void>;
  recoverableStarts(): Promise<
    readonly {
      input: SupervisorMessageV2Input;
      trustedScope: TrustedSupervisorMessageV2Scope;
      workflowId: string;
    }[]
  >;
  /** The durable start intent of this scoped workflow; refuses any other. */
  startIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<SupervisorMessageV2Input>;
  terminalOutcome(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<SupervisorMessageV2TerminalOutcome | undefined>;
  /**
   * The workflow id a received message runs under. A dedupe key this scope
   * recorded before workflow ids carried a deployment keeps its legacy id;
   * any other resolves to this deployment's id.
   */
  workflowIdFor(
    trustedScope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): Promise<string>;
}

export interface SupervisorMessageV2ReceiveResult {
  created: boolean;
  projection: SupervisorMessageV2Projection;
  workflowId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const v1InputOf = (
  input: SupervisorMessageV2Input
): SupervisorMessageInput => ({
  artifactRefs: input.artifactRefs,
  body: input.body,
  dedupeKey: input.dedupeKey,
  from: input.from,
  messageId: input.messageId,
  policy: input.policy,
  receivedAt: input.receivedAt,
  threadId: input.threadId,
  to: input.to,
});

const v1StateOf = (state: SupervisorMessageV2State): JsonObject => {
  const {
    principal: _principal,
    schema: _schema,
    tenantId: _tenantId,
    ...v1
  } = state;
  return v1;
};

const asV2State = (
  state: JsonObject,
  scope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2State =>
  parseSupervisorMessageV2State(
    {
      ...state,
      principal: scope.principal,
      schema: "supervisor-message-state.v2",
      tenantId: scope.tenantId,
    },
    scope
  );

const actionForState = (
  state: SupervisorMessageV2State
): SupervisorMessageV2Projection["actionRequired"] => {
  if (state.phase === "claimed") {
    return "acknowledge";
  }
  if (state.phase === "dead-lettered") {
    return "dead-letter";
  }
  if (state.phase === "retry-scheduled") {
    return "retry";
  }
  if (state.phase === "routed" || state.phase === "escalated") {
    return "claim";
  }
  return "none";
};

const projectionOf = (
  state: SupervisorMessageV2State
): SupervisorMessageV2Projection =>
  parseSupervisorMessageV2Projection(
    {
      acknowledgedAt: state.acknowledgedAt,
      actionRequired: actionForState(state),
      artifactRefs: state.artifactRefs,
      claimedAt: state.claimedAt,
      claimedBy: state.claimedBy,
      deadLetteredAt: state.deadLetteredAt,
      deliveredAt: state.deliveredAt,
      deliveryAttempts: state.deliveryAttempts,
      escalatedAt: state.escalatedAt,
      from: state.from,
      messageId: state.messageId,
      nextRetryAt: state.nextRetryAt,
      phase: state.phase,
      principal: state.principal,
      receivedAt: state.receivedAt,
      schema: "supervisor-message-status.v2",
      tenantId: state.tenantId,
      threadId: state.threadId,
      to: state.to,
    },
    { principal: state.principal, tenantId: state.tenantId }
  );

/**
 * The one mapping from a message's state to its terminal outcome, used by the
 * delivery path and both sweep paths so the recorded label never depends on
 * which path wrote first. An ended phase maps to its outcome; an open phase
 * is an outcome only when the engine closed the execution (`terminated`).
 */
const terminalOutcomeOf = (
  projection: SupervisorMessageV2Projection,
  maxDeliveryAttempts: number,
  executionClosed: boolean
): SupervisorMessageV2TerminalOutcome | undefined => {
  if (projection.phase === "acknowledged") {
    return "acknowledged";
  }
  if (projection.phase === "canceled") {
    return "canceled";
  }
  if (projection.phase === "dead-lettered") {
    return projection.deliveredAt === null &&
      projection.deliveryAttempts >= maxDeliveryAttempts
      ? "exhausted"
      : "dead-lettered";
  }
  return executionClosed ? "terminated" : undefined;
};

const scopeFromArgs = (
  args: JsonObject | undefined,
  state: SupervisorMessageV2State
): TrustedSupervisorMessageV2Scope => {
  const scope = args?.trustedScope;
  const parsed = parseSupervisorMessageV2Input(
    {
      artifactRefs: state.artifactRefs,
      body: state.body,
      dedupeKey: state.dedupeKey,
      from: state.from,
      messageId: state.messageId,
      policy: state.policy,
      principal: isRecord(scope) ? scope.principal : undefined,
      receivedAt: state.receivedAt,
      schema: "supervisor-message.v2",
      tenantId: isRecord(scope) ? scope.tenantId : undefined,
      threadId: state.threadId,
      to: state.to,
    },
    { principal: state.principal, tenantId: state.tenantId }
  );
  return { principal: parsed.principal, tenantId: parsed.tenantId };
};

const deliveryOf = (
  state: SupervisorMessageV2State,
  workflowId: string
): SupervisorMessageV2DeliveryEnvelope => {
  const deliveryAttempt = state.deliveryAttempts + 1;
  const scope = { principal: state.principal, tenantId: state.tenantId };
  const deliveryId = deriveSupervisorMessageV2DeliveryId(
    scope,
    workflowId,
    deliveryAttempt
  );
  return {
    artifactRefs: [...state.artifactRefs],
    body: state.body,
    deliveryAttempt,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: state.messageId,
    principal: state.principal,
    schema: "supervisor-message-delivery.v2",
    target: state.to,
    tenantId: state.tenantId,
    threadId: state.threadId,
    workflowId,
  };
};

const v2Transition = (
  stateValue: JsonObject,
  run: () => WorkflowTransitionResult
): WorkflowTransitionResult => {
  const state = parseSupervisorMessageV2State(stateValue, {
    principal: stateValue.principal as string,
    tenantId: stateValue.tenantId as string,
  });
  const result = run();
  return {
    ...result,
    state: asV2State(result.state, {
      principal: state.principal,
      tenantId: state.tenantId,
    }),
  };
};

/**
 * A V2 wrapper around the proven V1 state machine. It preserves V1 behavior
 * while carrying and validating the extra scope in a distinct workflow type.
 * No V1 workflow type or state codec is modified.
 */
export const supervisorMessageV2WorkflowDefinition: WorkflowDefinition = {
  cancel(state, reason, context) {
    return v2Transition(state, () =>
      supervisorMessageWorkflowDefinition.cancel(
        v1StateOf(
          parseSupervisorMessageV2State(state, {
            principal: state.principal as string,
            tenantId: state.tenantId as string,
          })
        ),
        reason,
        context
      )
    );
  },

  query(stateValue, name, args) {
    const state = parseSupervisorMessageV2State(stateValue, {
      principal: stateValue.principal as string,
      tenantId: stateValue.tenantId as string,
    });
    const scope = scopeFromArgs(args, state);
    if (name === "status") {
      return projectionOf({ ...state, ...scope });
    }
    if (name === "delivery_pending") {
      return state.phase === "routed" && state.deliveryStatus === "pending";
    }
    if (name === "delivery_request") {
      const workflowId = args?.workflowId;
      if (typeof workflowId !== "string") {
        throw new Error("SupervisorMessage V2 workflowId is required");
      }
      return deliveryOf(state, workflowId);
    }
    return supervisorMessageWorkflowDefinition.query(
      v1StateOf(state),
      name,
      args
    );
  },

  signal(state, name, payload, context) {
    return v2Transition(state, () =>
      supervisorMessageWorkflowDefinition.signal(
        v1StateOf(
          parseSupervisorMessageV2State(state, {
            principal: state.principal as string,
            tenantId: state.tenantId as string,
          })
        ),
        name,
        payload,
        context
      )
    );
  },

  start(input, context) {
    if (
      !(
        isRecord(input) &&
        isRecord(input.input) &&
        isRecord(input.trustedScope)
      )
    ) {
      throw new Error("SupervisorMessage V2 start input is invalid");
    }
    const scope = {
      principal: input.trustedScope.principal,
      tenantId: input.trustedScope.tenantId,
    };
    const message = parseSupervisorMessageV2Input(input.input, scope);
    const result = supervisorMessageWorkflowDefinition.start(
      v1InputOf(message),
      context
    );
    const state = asV2State(result.state, scope);
    return { ...result, result: projectionOf(state), state };
  },

  type: SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE,
};

export class SupervisorMessageV2Coordinator {
  readonly #delivery: SupervisorMessageV2DeliveryPort;
  readonly #dispatchOwner: string;
  readonly #ledger: SupervisorMessageV2DeliveryLedger;
  readonly #leaseMs: number;
  readonly #now: () => Date;
  readonly #readiness: SupervisorMessageV2DeliveryReadinessPort | undefined;
  readonly #workflows: WorkflowPort;

  constructor(
    workflows: WorkflowPort,
    delivery: SupervisorMessageV2DeliveryPort,
    ledger: SupervisorMessageV2DeliveryLedger,
    dispatchOwner: string,
    now: () => Date = () => new Date(),
    readiness?: SupervisorMessageV2DeliveryReadinessPort
  ) {
    if (!DISPATCH_OWNER.test(dispatchOwner)) {
      throw new Error("SupervisorMessage V2 dispatch owner is invalid");
    }
    // Workflow ids carry the ledger's deployment; an engine-backed port only
    // starts and adopts executions on its task queue. A ledger minting ids
    // for another deployment would put them on a queue that never owns them.
    if (
      workflows.taskQueue !== undefined &&
      workflows.taskQueue !== ledger.deployment
    ) {
      throw new Error(
        "SupervisorMessage V2 ledger deployment does not match the workflow port task queue"
      );
    }
    this.#delivery = delivery;
    this.#dispatchOwner = dispatchOwner;
    this.#ledger = ledger;
    this.#leaseMs = 30_000;
    this.#now = now;
    this.#readiness = readiness;
    this.#workflows = workflows;
  }

  async receive(
    trustedScope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input,
    requestId: string
  ): Promise<SupervisorMessageV2ReceiveResult> {
    const parsed = parseSupervisorMessageV2Input(input, trustedScope);
    // The ledger resolves the id: a dedupe key accepted before the format
    // change keeps its legacy id, so the message is never started twice.
    const workflowId = await this.#ledger.workflowIdFor(
      trustedScope,
      parsed.dedupeKey
    );
    // The ledger returns the original accepted payload. A retry can arrive
    // later, but a crash between intent insertion and Temporal start must
    // still start the workflow with that original durable input.
    const durableInput = await this.#ledger.recordStartIntent(
      workflowId,
      trustedScope,
      parsed
    );
    if (
      (await this.#presence(workflowId)) === "missing" &&
      (await this.#closedInLedger(trustedScope, workflowId))
    ) {
      // A sender retry after retention purged the finished execution. The
      // dedupe key already reached a terminal outcome or was delivered;
      // starting it again would reopen it and deliver the message again.
      throw new WorkflowError(
        "conflict",
        `workflow ${workflowId} is closed and its execution was purged`
      );
    }
    const started = await this.#workflows.start({
      input: { input: durableInput, trustedScope },
      requestId,
      workflowId,
      workflowType: SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE,
    });
    if (await this.#deliveryPending(trustedScope, workflowId)) {
      await this.#deliver(trustedScope, workflowId, `${requestId}:delivery`);
    }
    return {
      created: started.created,
      projection: await this.status(trustedScope, workflowId),
      workflowId,
    };
  }

  /**
   * Service-start recovery. The durable ledger supplies only canonical V2
   * envelopes whose earlier lease has expired, so an interrupted external
   * effect can converge without a sender replaying the original request.
   *
   * Each record is recovered on its own: one that fails (an ID held by a
   * foreign execution, a Temporal error for that workflow) does not stop the
   * others. With `report`, each such failure is handed to it and the sweep
   * resolves; without it, the first failure is thrown after every other
   * record was attempted. Reading the ledger itself still fails the sweep.
   */
  async recoverPending(
    report?: (failure: SupervisorMessageV2RecoveryFailure) => void
  ): Promise<number> {
    let recovered = 0;
    let unreported: { error: unknown } | undefined;
    for (const record of await this.#ledger.recoverableStarts()) {
      // A failure confined to one intent (an ID held by another deployment's
      // execution, a Temporal error for that workflow) is deferred or
      // reported: the sweep still recovers the remaining intents.
      const deferred: unknown[] = [];
      try {
        if (await this.#recoverStart(record, deferred)) {
          recovered += 1;
        }
      } catch (error) {
        deferred.push(error);
      }
      for (const error of deferred) {
        if (!report) {
          unreported ??= { error };
          continue;
        }
        report({
          error,
          recipient: record.input.to,
          workflowId: record.workflowId,
        });
      }
    }
    if (unreported) {
      throw unreported.error;
    }
    return recovered;
  }

  async #recoverStart(
    record: {
      input: SupervisorMessageV2Input;
      trustedScope: TrustedSupervisorMessageV2Scope;
      workflowId: string;
    },
    deferred: unknown[]
  ): Promise<boolean> {
    const { input, trustedScope, workflowId } = record;
    if (await this.#closedForRecovery(record, deferred)) {
      return false;
    }
    try {
      await this.#workflows.start({
        input: { input, trustedScope },
        requestId: `recovery-start:${workflowId}`,
        workflowId,
        workflowType: SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE,
      });
    } catch (error) {
      // The ID is held by an execution this host does not own. Leave it
      // alone, recover the remaining intents, and still fail the sweep.
      if (!(error instanceof WorkflowError && error.code === "conflict")) {
        throw error;
      }
      deferred.push(error);
      return false;
    }
    const projection = await this.status(trustedScope, workflowId);
    // The execution is ours and running, yet its message may have ended
    // (a cancel issued outside this coordinator, or a process that stopped
    // before recording). Record it now, while the engine cannot purge it.
    const ended = terminalOutcomeOf(
      projection,
      input.policy.maxDeliveryAttempts,
      false
    );
    if (ended) {
      await this.#ledger.recordTerminalOutcome(workflowId, trustedScope, ended);
      return false;
    }
    if (
      projection.phase === "retry-scheduled" &&
      projection.nextRetryAt !== null &&
      Date.parse(projection.nextRetryAt) <= this.#now().getTime()
    ) {
      await this.#workflows.signal({
        name: "retry_due",
        payload: {},
        requestId: `recovery-retry:${workflowId}:${projection.nextRetryAt}`,
        workflowId,
      });
    }
    if (!(await this.#deliveryPending(trustedScope, workflowId))) {
      return false;
    }
    // A delivery deferred by a readiness-store outage stays pending for the
    // next sweep and is not counted as recovered.
    return (
      (await this.#deliver(
        trustedScope,
        workflowId,
        `recovery:${workflowId}`
      )) === "attempted"
    );
  }

  /** Whether recovery must leave this intent's workflow alone. */
  async #closedForRecovery(
    record: {
      input: SupervisorMessageV2Input;
      trustedScope: TrustedSupervisorMessageV2Scope;
      workflowId: string;
    },
    deferred: unknown[]
  ): Promise<boolean> {
    const { input, trustedScope, workflowId } = record;
    if (await this.#ledger.terminalOutcome(workflowId, trustedScope)) {
      return true;
    }
    let presence: WorkflowPresence | undefined;
    try {
      presence = await this.#recoveryPresence(workflowId);
    } catch (error) {
      // Another deployment's execution holds this ID. It is neither ours to
      // start nor ours to read an outcome from: leave the intent open.
      if (!(error instanceof WorkflowError && error.code === "conflict")) {
        throw error;
      }
      deferred.push(error);
      return true;
    }
    if (presence === "closed") {
      // Record the outcome while the engine still holds the execution, so a
      // later retention purge cannot make it look never started.
      try {
        await this.#recordClosedOutcome(trustedScope, workflowId, input);
      } catch (error) {
        deferred.push(error);
      }
      return true;
    }
    return (
      presence === "missing" &&
      (await this.#ledger.hasCompletedDelivery(workflowId, trustedScope))
    );
  }

  async status(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<SupervisorMessageV2Projection> {
    // Refuse a cross-scope read locally. A Temporal query error is not a
    // transport-level authorization result and can otherwise wait until the
    // caller's timeout after the request has left the authenticated boundary.
    await this.#ledger.assertStartIntent(workflowId, trustedScope);
    const result = await this.#workflows.query({
      args: { trustedScope },
      name: "status",
      workflowId,
    });
    return result.value as SupervisorMessageV2Projection;
  }

  async claim(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    claimant: string,
    requestId: string
  ): Promise<SupervisorMessageV2Projection> {
    const projection = await this.status(trustedScope, workflowId);
    if (
      projection.to === claimant &&
      projection.phase === "retry-scheduled" &&
      projection.nextRetryAt !== null &&
      Date.parse(projection.nextRetryAt) <= this.#now().getTime()
    ) {
      // Reuse canonical due-retry and the fenced delivery boundary for this
      // exact assignment. The bridge adopts a durable accepted logical turn;
      // neither recipient credentials nor claim intent imply acceptance.
      await this.#workflows.signal({
        name: "retry_due",
        payload: {},
        requestId: `recovery-retry:${workflowId}:${projection.nextRetryAt}`,
        workflowId,
      });
      if (await this.#deliveryPending(trustedScope, workflowId)) {
        await this.#deliver(
          trustedScope,
          workflowId,
          `recipient-recovery:${requestId}`
        );
      }
    }
    await this.#workflows.signal({
      name: "claim",
      payload: { claimant },
      requestId,
      workflowId,
    });
    return this.status(trustedScope, workflowId);
  }

  /**
   * Acknowledgement is a recipient lifecycle fact, not an assertion that the
   * underlying work is complete.  As with every other V2 command, establish
   * the authenticated scope against the durable start intent before a signal
   * can leave this process.
   */
  async acknowledge(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    claimant: string,
    requestId: string
  ): Promise<SupervisorMessageV2Projection> {
    await this.status(trustedScope, workflowId);
    const receipt = await this.#workflows.signal({
      name: "acknowledge",
      payload: { claimant },
      requestId,
      workflowId,
    });
    if (receipt.status === "completed") {
      // The workflow-level status is V1's "completed"; the durable marker
      // names what happened, a recipient acknowledgement.
      await this.#ledger.recordTerminalOutcome(
        workflowId,
        trustedScope,
        "acknowledged"
      );
    }
    return this.status(trustedScope, workflowId);
  }

  async #deliver(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    requestId: string
  ): Promise<"attempted" | "deferred"> {
    const request = await this.#workflows.query({
      args: { trustedScope, workflowId },
      name: "delivery_request",
      workflowId,
    });
    const envelope = request.value as SupervisorMessageV2DeliveryEnvelope;
    // Recovery repeats its logical request key. Each scheduled attempt must
    // retain a distinct Temporal command receipt, while the bridge continues
    // deduplicating the one logical provider effect across attempts.
    const outcomeRequestId = `${requestId}:${envelope.deliveryId}`;
    // Do this before claiming or calling the provider. A stale, missing, or
    // cross-scope descriptor becomes a normal retryable delivery failure and
    // cannot consume an external provider turn. The failure is signalled only
    // under this attempt's lease, so it cannot fail an attempt another
    // dispatcher holds, and its reason stays opaque: no session detail
    // reaches workflow state.
    let ready = true;
    try {
      await this.#readiness?.assertReady(trustedScope, envelope.target);
    } catch (error) {
      if (error instanceof SupervisorMessageV2ReadinessUnavailableError) {
        // The readiness store could not answer: that says nothing about the
        // seat. Leave the delivery pending without claiming a lease or
        // spending one of the message's attempts; the existing recovery
        // sweep retries it once the store answers again.
        return "deferred";
      }
      ready = false;
    }
    const claim = await this.#ledger.claim(
      envelope,
      trustedScope,
      this.#dispatchOwner,
      this.#now(),
      this.#leaseMs
    );
    if (claim.state === "busy" || claim.state === "closed") {
      return "attempted";
    }
    if (claim.state === "succeeded") {
      await this.#workflows.signal({
        name: "delivery_succeeded",
        payload: {},
        requestId: outcomeRequestId,
        workflowId,
      });
      return "attempted";
    }
    let outcome: SupervisorMessageV2DeliveryOutcome;
    try {
      outcome = ready
        ? await this.#delivery.deliver(envelope)
        : {
            reason: "recipient session is not ready",
            status: "transient-failure",
          };
    } catch (error) {
      outcome = {
        reason: error instanceof Error ? error.message : "delivery threw",
        status: "transient-failure",
      };
    }
    if (outcome.status === "accepted") {
      await this.#ledger.completeClaim(
        envelope,
        trustedScope,
        this.#dispatchOwner,
        claim.fence
      );
    }
    const receipt = await this.#workflows.signal({
      name:
        outcome.status === "accepted"
          ? "delivery_succeeded"
          : "delivery_failed",
      payload:
        outcome.status === "accepted"
          ? {}
          : {
              permanent: outcome.status === "permanent-failure",
              reason: outcome.reason,
            },
      requestId: outcomeRequestId,
      workflowId,
    });
    if (outcome.status !== "accepted" && receipt.status !== "running") {
      // The failure ended the message. Label it from its state, as a sweep
      // would: a failed last attempt is exhausted whatever its kind.
      const input = await this.#ledger.startIntent(workflowId, trustedScope);
      const ended = terminalOutcomeOf(
        await this.status(trustedScope, workflowId),
        input.policy.maxDeliveryAttempts,
        false
      );
      if (ended) {
        await this.#ledger.recordTerminalOutcome(
          workflowId,
          trustedScope,
          ended
        );
      }
    }
    return "attempted";
  }

  /**
   * A closed execution needs no recovery. A missing one is ambiguous: the
   * process stopped between recording the start intent and starting the
   * workflow, or the engine purged a closed execution after retention. Only
   * the first may be started, so recovery and sender retries consult the
   * ledger: a recorded terminal outcome or a completed delivery proves the
   * workflow ran. A port that cannot tell missing from running keeps the
   * earlier start-and-converge behavior.
   */
  async #recoveryPresence(
    workflowId: string
  ): Promise<WorkflowPresence | undefined> {
    const presence = await this.#presence(workflowId);
    if (
      presence === undefined &&
      (await this.#workflows.isClosed?.(workflowId))
    ) {
      return "closed";
    }
    return presence;
  }

  async #closedInLedger(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<boolean> {
    return (
      (await this.#ledger.terminalOutcome(workflowId, trustedScope)) !==
        undefined ||
      (await this.#ledger.hasCompletedDelivery(workflowId, trustedScope))
    );
  }

  async #recordClosedOutcome(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    input: SupervisorMessageV2Input
  ): Promise<void> {
    const projection = await this.status(trustedScope, workflowId);
    // The status query addresses the ID, not the execution the presence
    // check saw. Record only if the ID still names our own closed execution:
    // a foreign one raises a conflict here, and a purged one is not proof.
    if ((await this.#recoveryPresence(workflowId)) !== "closed") {
      return;
    }
    const outcome = terminalOutcomeOf(
      projection,
      input.policy.maxDeliveryAttempts,
      true
    );
    if (outcome) {
      await this.#ledger.recordTerminalOutcome(
        workflowId,
        trustedScope,
        outcome
      );
    }
  }

  async #presence(workflowId: string): Promise<WorkflowPresence | undefined> {
    return this.#workflows.presence
      ? await this.#workflows.presence(workflowId)
      : undefined;
  }

  async #deliveryPending(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<boolean> {
    const result = await this.#workflows.query({
      args: { trustedScope },
      name: "delivery_pending",
      workflowId,
    });
    return result.value === true;
  }
}

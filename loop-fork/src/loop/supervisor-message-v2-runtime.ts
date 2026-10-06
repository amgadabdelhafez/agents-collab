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

/** How long a readiness-store outage may defer one recipient's deliveries. */
export const SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS = 900_000;
/**
 * An outage nothing observed for this long is over: recovery sweeps every
 * pending delivery at least this often (its interval's ceiling), so a gap this
 * long means no delivery waited on the store, not one continuous outage.
 */
const READINESS_OUTAGE_UNOBSERVED_MS = 3_600_000;
/** The fixed, opaque delivery_failed reason once an outage is past its bound. */
const READINESS_UNAVAILABLE_REASON = "session readiness store is unavailable";

/** Cumulative since process start, except the current recipient count. */
export interface SupervisorMessageV2ReadinessOutageSnapshot {
  boundMs: number;
  /** Deliveries left pending, without an attempt, because the store was down. */
  deferredDeliveries: number;
  /** Deliveries failed as a retryable attempt because the outage outlasted the bound. */
  outageFailures: number;
  /** Recipients whose deliveries currently wait on the readiness store. */
  recipientsDeferred: number;
}

/**
 * Bounds the deferral a readiness-store outage causes. Deferral spends no
 * delivery attempt, so without a bound a long outage would hold a message
 * forever with nothing said. Each recipient's outage is logged once when it
 * starts deferring deliveries, once if it outlasts the bound, and once when the
 * store answers for that recipient again. Past the bound, each delivery is a
 * normal retryable failure that consumes an attempt, so the message's own
 * retry policy ends it. State is in memory: a restarted process starts the
 * bound again for an outage still in progress.
 */
export class SupervisorMessageV2ReadinessOutageTracker {
  readonly #boundMs: number;
  readonly #log: (line: string) => void;
  readonly #outages = new Map<
    string,
    { exceeded: boolean; observedAt: number; since: number }
  >();
  #deferred = 0;
  #failed = 0;

  constructor(
    options: { boundMs?: number; log?: (line: string) => void } = {}
  ) {
    const boundMs =
      options.boundMs ?? SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS;
    if (
      !Number.isSafeInteger(boundMs) ||
      boundMs < 1000 ||
      boundMs > 86_400_000
    ) {
      throw new Error("V2 readiness outage bound is invalid");
    }
    this.#boundMs = boundMs;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  /** The store could not answer for this recipient: defer, or fail the attempt. */
  unavailable(recipient: string, now: Date): "defer" | "fail" {
    const at = now.getTime();
    let outage = this.#outages.get(recipient);
    if (!outage || this.#unobserved(outage, at)) {
      outage = { exceeded: false, observedAt: at, since: at };
      this.#outages.set(recipient, outage);
      this.#log(
        `V2 delivery to ${recipient} deferred: ${READINESS_UNAVAILABLE_REASON}`
      );
    }
    outage.observedAt = at;
    if (at - outage.since < this.#boundMs) {
      this.#deferred += 1;
      return "defer";
    }
    if (!outage.exceeded) {
      outage.exceeded = true;
      this.#log(
        `V2 delivery to ${recipient} still deferred after ${this.#boundMs}ms: the readiness store outage now fails delivery attempts`
      );
    }
    this.#failed += 1;
    return "fail";
  }

  /** The store answered for this recipient, ready or not: its outage is over. */
  answered(recipient: string, now: Date): void {
    const outage = this.#outages.get(recipient);
    if (!outage) {
      return;
    }
    this.#outages.delete(recipient);
    this.#log(
      `V2 delivery to ${recipient} resumed after ${now.getTime() - outage.since}ms: session readiness store answered`
    );
  }

  snapshot(now: Date = new Date()): SupervisorMessageV2ReadinessOutageSnapshot {
    const at = now.getTime();
    return {
      boundMs: this.#boundMs,
      deferredDeliveries: this.#deferred,
      outageFailures: this.#failed,
      recipientsDeferred: [...this.#outages.values()].filter(
        (outage) => !this.#unobserved(outage, at)
      ).length,
    };
  }

  #unobserved(outage: { observedAt: number }, at: number): boolean {
    return (
      at - outage.observedAt >
      Math.max(this.#boundMs, READINESS_OUTAGE_UNOBSERVED_MS)
    );
  }
}

/**
 * Explicit lifecycle hook for a V2-capable service. It intentionally keeps
 * recovery out of the sender request path: service startup performs one
 * durable sweep, and the configured period handles abandoned pre-dispatch and
 * post-effect records. A caller must opt in and own its shutdown lifecycle.
 */
export interface SupervisorMessageV2RecoveryPort {
  /**
   * With `due`, a record whose workflow ID it rejects is left alone for this
   * sweep: not attempted, not reported, not counted.
   */
  recoverPending(
    report?: (failure: SupervisorMessageV2RecoveryFailure) => void,
    due?: (workflowId: string) => boolean
  ): Promise<number>;
}

/**
 * One recorded start that a recovery sweep could not recover.
 * `foreign-execution`: the workflow ID is held by an execution this
 * deployment does not own (another task queue or another workflow type), as
 * raised by the port's start or presence check for that ID. `failed`: any
 * other failure for this record, including a PostgreSQL error and a conflict
 * raised by any later step.
 */
export interface SupervisorMessageV2RecoveryFailure {
  error: unknown;
  kind: "failed" | "foreign-execution";
  recipient: string;
  workflowId: string;
}

/** A failure of one record, before the sweep names its record. */
type RecordFailure = Pick<SupervisorMessageV2RecoveryFailure, "error" | "kind">;

/**
 * The port raises a conflict when an ID this host starts or checks is held
 * by an execution it does not own (another task queue or workflow type).
 */
const isForeignExecution = (error: unknown): boolean =>
  error instanceof WorkflowError && error.code === "conflict";

const recoveryFailureText = (error: unknown): string => {
  if (error instanceof WorkflowError) {
    return `WorkflowError (${error.code}): ${error.message}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : "unknown error";
};

const recordText = (failure: SupervisorMessageV2RecoveryFailure): string =>
  `workflow ${failure.workflowId} for ${failure.recipient}`;

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Service-start recovery refuses to start the host when a recorded start
 * failed for any reason other than a foreign execution holding its ID.
 */
export class SupervisorMessageV2RecoveryStartupError extends Error {
  readonly failures: readonly SupervisorMessageV2RecoveryFailure[];

  constructor(failures: readonly SupervisorMessageV2RecoveryFailure[]) {
    super(
      `V2 initial recovery failed for ${plural(failures.length, "recorded start")}: ${failures
        .map(
          (failure) =>
            `${recordText(failure)}: ${recoveryFailureText(failure.error)}`
        )
        .join("; ")}`
    );
    this.name = "SupervisorMessageV2RecoveryStartupError";
    this.failures = failures;
  }
}

export interface SupervisorMessageV2RecoveryRunnerOptions {
  coordinator: SupervisorMessageV2RecoveryPort;
  intervalMs: number;
  log?: (message: string) => void;
  /**
   * Upper bound of a failing record's retry delay. Attempt n of a failing
   * record waits min(intervalMs * 2^(n-1), maxBackoffMs) before the next.
   * Defaults to ten minutes, never below `intervalMs`.
   */
  maxBackoffMs?: number;
  now?: () => number;
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

/** Default upper bound of a failing record's retry delay. */
const DEFAULT_MAX_RECOVERY_BACKOFF_MS = 600_000;

/** A record whose recovery failed, waiting for its next attempt. */
interface SupervisorMessageV2FailingRecovery {
  attempts: number;
  recipient: string;
  retryAt: number;
}

/**
 * Runs service-start recovery and the periodic sweep.
 *
 * Service start: only a record whose ID is held by an execution this
 * deployment does not own is skipped (logged with its ID and recipient), so
 * a foreign deployment cannot keep this host down. Any other per-record
 * failure refuses startup, naming every failing record, after every other
 * record was recovered; so does a failure of the whole sweep.
 *
 * Periodic sweep: a failing record is retried with bounded exponential
 * backoff, and every transition is logged: each failed attempt (with its
 * attempt number and delay), its recovery, and its removal from the ledger.
 * A failing record never delays the others.
 */
export class SupervisorMessageV2RecoveryRunner
  implements SupervisorMessageV2RecoveryLifecycle
{
  readonly #coordinator: SupervisorMessageV2RecoveryPort;
  /** workflowId -> the record's failure state, until it recovers. */
  readonly #failing = new Map<string, SupervisorMessageV2FailingRecovery>();
  readonly #intervalMs: number;
  readonly #log: (message: string) => void;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
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
    const maxBackoffMs =
      options.maxBackoffMs ??
      Math.max(options.intervalMs, DEFAULT_MAX_RECOVERY_BACKOFF_MS);
    if (
      !Number.isSafeInteger(maxBackoffMs) ||
      maxBackoffMs < options.intervalMs ||
      maxBackoffMs > 3_600_000
    ) {
      throw new Error("V2 recovery backoff bound is invalid");
    }
    this.#coordinator = options.coordinator;
    this.#intervalMs = options.intervalMs;
    this.#log = options.log ?? ((message) => console.error(message));
    this.#maxBackoffMs = maxBackoffMs;
    this.#now = options.now ?? Date.now;
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

  /** One periodic sweep. Only a failure of the whole sweep rejects. */
  sweep(): Promise<number> {
    return this.#sweep(false);
  }

  async #sweep(initial: boolean): Promise<number> {
    if (this.#closed) {
      return 0;
    }
    if (this.#inFlight) {
      return 0;
    }
    const now = this.#now();
    const recorded = new Set<string>();
    const attempted = new Set<string>();
    const failures: SupervisorMessageV2RecoveryFailure[] = [];
    const run = this.#coordinator.recoverPending(
      (failure) => {
        failures.push(failure);
      },
      (workflowId) => {
        recorded.add(workflowId);
        const failing = this.#failing.get(workflowId);
        if (failing !== undefined && failing.retryAt > now) {
          return false;
        }
        attempted.add(workflowId);
        return true;
      }
    );
    this.#inFlight = run;
    try {
      const recovered = await run;
      this.#reportSkips(
        failures.filter((failure) => failure.kind === "foreign-execution")
      );
      const failed = failures.filter(
        (failure) => failure.kind !== "foreign-execution"
      );
      if (initial && failed.length > 0) {
        throw new SupervisorMessageV2RecoveryStartupError(failed);
      }
      this.#retryLater(failed, now, recorded, attempted);
      return recovered;
    } finally {
      if (this.#inFlight === run) {
        this.#inFlight = undefined;
      }
    }
  }

  /**
   * An ID held by another deployment's execution stays held until that
   * execution is purged. It degrades only that message's recipient, is
   * logged once per distinct line, and is looked at again on every sweep.
   */
  #reportSkips(skips: readonly SupervisorMessageV2RecoveryFailure[]): void {
    const skipped = new Map<string, string>();
    for (const failure of skips) {
      skipped.set(
        failure.workflowId,
        `V2 recovery skipped ${recordText(failure)}: ${recoveryFailureText(failure.error)}`
      );
    }
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
  }

  #retryLater(
    failed: readonly SupervisorMessageV2RecoveryFailure[],
    now: number,
    recorded: ReadonlySet<string>,
    attempted: ReadonlySet<string>
  ): void {
    const failedNow = new Set(failed.map((failure) => failure.workflowId));
    for (const [workflowId, failing] of this.#failing) {
      const record = `workflow ${workflowId} for ${failing.recipient}`;
      const attempts = plural(failing.attempts, "failed attempt");
      if (!recorded.has(workflowId)) {
        this.#failing.delete(workflowId);
        this.#log(
          `V2 recovery of ${record} stopped: its start intent is no longer recorded after ${attempts}`
        );
      } else if (attempted.has(workflowId) && !failedNow.has(workflowId)) {
        this.#failing.delete(workflowId);
        this.#log(`V2 recovery of ${record} resumed after ${attempts}`);
      }
    }
    for (const failure of failed) {
      const attempts =
        (this.#failing.get(failure.workflowId)?.attempts ?? 0) + 1;
      const delayMs = Math.min(
        this.#intervalMs * 2 ** (attempts - 1),
        this.#maxBackoffMs
      );
      this.#failing.set(failure.workflowId, {
        attempts,
        recipient: failure.recipient,
        retryAt: now + delayMs,
      });
      this.#log(
        `V2 recovery of ${recordText(failure)} failed (attempt ${attempts}); retrying in ${delayMs} ms: ${recoveryFailureText(failure.error)}`
      );
    }
  }

  async #start(): Promise<void> {
    // Any failure but a foreign-held ID refuses startup, including a failure
    // of the whole sweep: the host must not serve while a recorded start it
    // owns cannot be recovered.
    await this.#sweep(true);
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
  readonly #readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
  readonly #workflows: WorkflowPort;

  constructor(
    workflows: WorkflowPort,
    delivery: SupervisorMessageV2DeliveryPort,
    ledger: SupervisorMessageV2DeliveryLedger,
    dispatchOwner: string,
    now: () => Date = () => new Date(),
    readiness?: SupervisorMessageV2DeliveryReadinessPort,
    readinessOutage?: SupervisorMessageV2ReadinessOutageTracker
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
    this.#readinessOutage =
      readinessOutage ?? new SupervisorMessageV2ReadinessOutageTracker();
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
   * Each record is recovered on its own: one that fails does not stop the
   * others. A conflict the port raises when this host starts the ID or
   * checks its presence means another deployment's execution holds it; that
   * record is left alone and its failure is a `foreign-execution`. Any other
   * error (Temporal, PostgreSQL, a conflict from a later step) is `failed`.
   * With `report`, each failure is handed to it and the sweep resolves; the
   * caller decides what each kind means. Without it, the first failure is
   * thrown after every other record was attempted. Reading the ledger itself
   * still fails the sweep.
   */
  async recoverPending(
    report?: (failure: SupervisorMessageV2RecoveryFailure) => void,
    due?: (workflowId: string) => boolean
  ): Promise<number> {
    let recovered = 0;
    let unreported: { error: unknown } | undefined;
    for (const record of await this.#ledger.recoverableStarts()) {
      if (due && !due(record.workflowId)) {
        continue;
      }
      const failures: RecordFailure[] = [];
      try {
        if (await this.#recoverStart(record, failures)) {
          recovered += 1;
        }
      } catch (error) {
        failures.push({ error, kind: "failed" });
      }
      for (const { error, kind } of failures) {
        if (!report) {
          unreported ??= { error };
          continue;
        }
        report({
          error,
          kind,
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
    failures: RecordFailure[]
  ): Promise<boolean> {
    const { input, trustedScope, workflowId } = record;
    if (await this.#closedForRecovery(record, failures)) {
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
      // The ID is held by an execution this host does not own: leave it
      // alone. Any other start failure is this record's own failure.
      if (!isForeignExecution(error)) {
        throw error;
      }
      failures.push({ error, kind: "foreign-execution" });
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
    failures: RecordFailure[]
  ): Promise<boolean> {
    const { input, trustedScope, workflowId } = record;
    if (await this.#ledger.terminalOutcome(workflowId, trustedScope)) {
      return true;
    }
    const presence = await this.#ownPresence(workflowId, failures);
    if (presence === "foreign") {
      // Another deployment's execution holds this ID. It is neither ours to
      // start nor ours to read an outcome from: leave the intent open.
      return true;
    }
    if (presence === "closed") {
      // Record the outcome while the engine still holds the execution, so a
      // later retention purge cannot make it look never started.
      await this.#recordClosedOutcome(
        trustedScope,
        workflowId,
        input,
        failures
      );
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
    const readiness = await this.#readinessOf(trustedScope, envelope.target);
    if (readiness === "deferred") {
      // The readiness store could not answer: that says nothing about the
      // seat. Leave the delivery pending without claiming a lease or
      // spending one of the message's attempts; the existing recovery
      // sweep retries it once the store answers again. Past the outage
      // bound it is "unavailable" instead: a normal retryable failure.
      return "deferred";
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
      outcome =
        readiness === "ready"
          ? await this.#delivery.deliver(envelope)
          : {
              reason:
                readiness === "unavailable"
                  ? READINESS_UNAVAILABLE_REASON
                  : "recipient session is not ready",
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

  /** The recipient's readiness, or "deferred" while an outage is in bound. */
  async #readinessOf(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<"deferred" | "ready" | "unavailable" | "unready"> {
    try {
      await this.#readiness?.assertReady(trustedScope, recipient);
    } catch (error) {
      if (error instanceof SupervisorMessageV2ReadinessUnavailableError) {
        return this.#readinessOutage.unavailable(recipient, this.#now()) ===
          "defer"
          ? "deferred"
          : "unavailable";
      }
      this.#readinessOutage.answered(recipient, this.#now());
      return "unready";
    }
    this.#readinessOutage.answered(recipient, this.#now());
    return "ready";
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

  /**
   * This deployment's presence for the ID, or `foreign` (with the conflict
   * added to `failures`) when another deployment's execution holds it.
   */
  async #ownPresence(
    workflowId: string,
    failures: RecordFailure[]
  ): Promise<WorkflowPresence | "foreign" | undefined> {
    try {
      return await this.#recoveryPresence(workflowId);
    } catch (error) {
      if (!isForeignExecution(error)) {
        throw error;
      }
      failures.push({ error, kind: "foreign-execution" });
      return "foreign";
    }
  }

  async #recordClosedOutcome(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    input: SupervisorMessageV2Input,
    failures: RecordFailure[]
  ): Promise<void> {
    const projection = await this.status(trustedScope, workflowId);
    // The status query addresses the ID, not the execution the presence
    // check saw. Record only if the ID still names our own closed execution:
    // a foreign one raises a conflict here, and a purged one is not proof.
    if ((await this.#ownPresence(workflowId, failures)) !== "closed") {
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

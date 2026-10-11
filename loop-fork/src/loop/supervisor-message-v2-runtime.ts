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
  WorkflowForeignExecutionError,
  type WorkflowPort,
  type WorkflowPresence,
  type WorkflowTransitionResult,
} from "./workflow-port";

export const SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE = "supervisor-message.v2";
/** The schema every V2 message execution answers its status query with. */
const V2_STATUS_SCHEMA = "supervisor-message-status.v2";
const isV2Projection = (
  value: unknown
): value is SupervisorMessageV2Projection =>
  typeof value === "object" &&
  value !== null &&
  (value as { schema?: unknown }).schema === V2_STATUS_SCHEMA;
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
 * An outage nothing observed for this long, with no message it failed still
 * waiting on its retry, is over. A delivery the outage defers stays pending
 * and every recovery sweep (at most an hour apart) checks it again, so a gap
 * of twice that means no delivery was waiting on the store, even if one
 * sweep was skipped while another ran long.
 */
const READINESS_OUTAGE_UNOBSERVED_MS = 7_200_000;
/** The fixed, opaque delivery_failed reason once an outage is past its bound. */
const READINESS_UNAVAILABLE_REASON = "session readiness store is unavailable";

/** A deferral bound is whole milliseconds from one second to one day. */
const requireDeferralBoundMs = (
  value: number | undefined,
  fallback: number,
  label: string
): number => {
  const boundMs = value ?? fallback;
  if (
    !Number.isSafeInteger(boundMs) ||
    boundMs < 1000 ||
    boundMs > 86_400_000
  ) {
    throw new Error(`${label} is invalid`);
  }
  return boundMs;
};

/** Cumulative since process start, except the current recipient count. */
export interface SupervisorMessageV2ReadinessOutageSnapshot {
  boundMs: number;
  /**
   * Delivery passes left pending, without an attempt, because the store was
   * down. One message deferred on several recovery sweeps counts each time.
   */
  deferredDeliveries: number;
  /**
   * Delivery attempts recorded as failed because the outage outlasted the
   * bound: counted only once the failure was signalled under this
   * dispatcher's lease, never for a verdict another dispatcher's lease, a
   * closed message, or an already accepted delivery absorbed.
   */
  outageFailures: number;
  /**
   * Recipients a delivery found the store unable to answer for within the
   * last two hours, with no answer for them since.
   */
  recipientsDeferred: number;
}

/** One recipient's open readiness-store outage (epoch ms). */
interface ReadinessOutage {
  exceeded: boolean;
  /** Until when a message this outage failed waits on its retry delay. */
  heldUntil: number;
  /** The last delivery that found the store unable to answer. */
  observedAt: number;
  since: number;
}

/**
 * Bounds the deferral a readiness-store outage causes. Deferral spends no
 * delivery attempt, so without a bound a long outage would hold a message
 * forever with nothing said. Each recipient's outage is logged once when it
 * starts deferring deliveries, once if it outlasts the bound, and once when the
 * store answers for that recipient again. Past the bound, each delivery is a
 * normal retryable failure that consumes an attempt, so the message's own
 * retry policy ends it.
 *
 * The bound is measured from the first failure a delivery observed for that
 * recipient. An outage ends when the store answers for that recipient (ready
 * or not), or when nothing can still be waiting on it: no delivery observed
 * it for two hours (a deferred delivery is observed by every sweep) and no
 * message it failed is still waiting on its retry delay. So a message that
 * waits out a long retry mid-outage meets the bound measured from the
 * outage's start, not a fresh one, while a later, separate outage gets a
 * bound of its own and no recipient stays reported after its outage ended.
 * Only an answer for the recipient itself ends its outage: a failure the
 * store keeps for one recipient while it answers others is still bounded.
 *
 * One window remains: when a message the outage failed is cancelled or
 * delivered elsewhere while it waits on its retry delay, and nothing asks
 * the store about that recipient before a new outage starts within that
 * delay, the two count as one (each failed attempt is still retryable under
 * the message's policy). State is in memory: a restarted process starts the
 * bound again for an outage still in progress.
 */
export class SupervisorMessageV2ReadinessOutageTracker {
  readonly #boundMs: number;
  readonly #log: (line: string) => void;
  readonly #outages = new Map<string, ReadinessOutage>();
  #deferred = 0;
  #failed = 0;

  constructor(
    options: { boundMs?: number; log?: (line: string) => void } = {}
  ) {
    this.#boundMs = requireDeferralBoundMs(
      options.boundMs,
      SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS,
      "V2 readiness outage bound"
    );
    this.#log = options.log ?? ((line) => console.error(line));
  }

  /** The store could not answer for this recipient: defer, or fail the attempt. */
  unavailable(recipient: string, now: Date): "defer" | "fail" {
    const at = now.getTime();
    let outage = this.#outages.get(recipient);
    if (!outage || this.#over(outage, at)) {
      outage = { exceeded: false, heldUntil: at, observedAt: at, since: at };
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
    return "fail";
  }

  /**
   * A "fail" verdict became a delivery_failed recorded under a lease. With
   * `retryAt`, the message waits on its retry until then: the outage stays
   * open for it however long that is.
   */
  failedAttempt(recipient: string, retryAt?: Date): void {
    this.#failed += 1;
    const outage = this.#outages.get(recipient);
    if (outage && retryAt) {
      outage.heldUntil = Math.max(outage.heldUntil, retryAt.getTime());
    }
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

  /**
   * The recipients a delivery found in an outage within the last two hours,
   * sorted. Detail for authenticated callers only.
   */
  recipients(now: Date = new Date()): string[] {
    const at = now.getTime();
    return [...this.#outages]
      .filter(([, outage]) => this.#observedRecently(outage, at))
      .map(([recipient]) => recipient)
      .sort();
  }

  snapshot(now: Date = new Date()): SupervisorMessageV2ReadinessOutageSnapshot {
    return {
      boundMs: this.#boundMs,
      deferredDeliveries: this.#deferred,
      outageFailures: this.#failed,
      recipientsDeferred: this.recipients(now).length,
    };
  }

  #observedRecently(outage: ReadinessOutage, at: number): boolean {
    return at - outage.observedAt <= READINESS_OUTAGE_UNOBSERVED_MS;
  }

  /** Nothing observed it lately and no message it failed still waits on it. */
  #over(outage: ReadinessOutage, at: number): boolean {
    return (
      at - Math.max(outage.observedAt, outage.heldUntil) >
      READINESS_OUTAGE_UNOBSERVED_MS
    );
  }
}

/** How long a recipient that is not enrolled may defer its deliveries. */
export const SUPERVISOR_MESSAGE_V2_NOT_ENROLLED_BOUND_MS = 900_000;
/** The fixed, opaque delivery_failed reason once not-enrolled is past its bound. */
const NOT_ENROLLED_REASON = "recipient session is not enrolled";

/** What the delivery boundary learned about the recipient before claiming. */
type DeliveryReadiness =
  | "deferred"
  | "not-enrolled"
  | "ready"
  | "unavailable"
  | "unready";

/** The fixed, opaque delivery_failed reason for a refusal before the provider. */
const readinessFailureReason = (
  readiness: Exclude<DeliveryReadiness, "deferred" | "ready">
): string => {
  if (readiness === "unavailable") {
    return READINESS_UNAVAILABLE_REASON;
  }
  if (readiness === "not-enrolled") {
    return NOT_ENROLLED_REASON;
  }
  return "recipient session is not ready";
};

/**
 * Says whether a recipient is enrolled now, as the server's own enrollment
 * pass last found it: the instant (epoch ms) its current not-enrolled spell
 * began, or undefined while it is enrolled or not one of the enrolled seats.
 */
export interface SupervisorMessageV2RecipientEnrollmentPort {
  notEnrolledSince(recipient: string): number | undefined;
}

/** Cumulative since process start, except the current recipient count. */
export interface SupervisorMessageV2NotEnrolledSnapshot {
  boundMs: number;
  /**
   * Delivery passes left pending, without an attempt, because the recipient
   * was not enrolled. One message deferred on several sweeps counts each time.
   */
  deferredDeliveries: number;
  /** Delivery attempts recorded as failed because not-enrolled outlasted the bound. */
  notEnrolledFailures: number;
  /** Recipients whose deliveries wait now because they are not enrolled. */
  recipientsDeferred: number;
}

/**
 * Bounds the deferral of deliveries to a recipient that is not enrolled (a
 * seat that is stopped or unreachable, as the enrollment sweep last found
 * it). Such a recipient's deliveries would otherwise each spend an attempt on
 * the store's readiness refusal and could dead-letter while the seat is
 * merely down. Instead, while the store also says the recipient is not ready,
 * a delivery is deferred without an attempt or a lease. The bound is measured
 * from when the enrollment pass first found the recipient not enrolled (the
 * sweep re-checks it continuously), so no retry delay can restart it. Past
 * the bound each delivery is a normal retryable failure with a fixed opaque
 * reason, so the message's own retry policy ends it. Logged once per spell
 * when deferral starts, once if it outlasts the bound, and once when the
 * recipient's delivery resumes. State is in memory, as the enrollment's is: a
 * restarted process starts the bound again.
 */
export class SupervisorMessageV2NotEnrolledDeferral {
  readonly #boundMs: number;
  readonly #enrollment: SupervisorMessageV2RecipientEnrollmentPort | undefined;
  readonly #log: (line: string) => void;
  readonly #spells = new Map<string, { exceeded: boolean; since: number }>();
  #deferred = 0;
  #failed = 0;

  constructor(
    options: {
      boundMs?: number;
      enrollment?: SupervisorMessageV2RecipientEnrollmentPort;
      log?: (line: string) => void;
    } = {}
  ) {
    this.#boundMs = requireDeferralBoundMs(
      options.boundMs,
      SUPERVISOR_MESSAGE_V2_NOT_ENROLLED_BOUND_MS,
      "V2 not-enrolled deferral bound"
    );
    this.#enrollment = options.enrollment;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  /**
   * The store refused this recipient as not ready. Undefined when it is
   * enrolled (the refusal is an ordinary attempt); otherwise defer within the
   * bound, or fail the attempt past it.
   */
  unready(recipient: string, now: Date): "defer" | "fail" | undefined {
    const since = this.#enrollment?.notEnrolledSince(recipient);
    if (since === undefined) {
      return undefined;
    }
    let spell = this.#spells.get(recipient);
    if (spell?.since !== since) {
      spell = { exceeded: false, since };
      this.#spells.set(recipient, spell);
      this.#log(`V2 delivery to ${recipient} deferred: ${NOT_ENROLLED_REASON}`);
    }
    if (now.getTime() - since < this.#boundMs) {
      this.#deferred += 1;
      return "defer";
    }
    if (!spell.exceeded) {
      spell.exceeded = true;
      this.#log(
        `V2 delivery to ${recipient} still deferred after ${this.#boundMs}ms not enrolled: delivery attempts now fail`
      );
    }
    return "fail";
  }

  /** A "fail" verdict became a delivery_failed recorded under a lease. */
  failedAttempt(): void {
    this.#failed += 1;
  }

  /** The store found the recipient ready: any deferral of it is over. */
  ready(recipient: string, now: Date): void {
    const spell = this.#spells.get(recipient);
    if (!spell) {
      return;
    }
    this.#spells.delete(recipient);
    this.#log(
      `V2 delivery to ${recipient} resumed after ${now.getTime() - spell.since}ms: recipient session is enrolled and ready`
    );
  }

  snapshot(): SupervisorMessageV2NotEnrolledSnapshot {
    return {
      boundMs: this.#boundMs,
      deferredDeliveries: this.#deferred,
      notEnrolledFailures: this.#failed,
      recipientsDeferred: [...this.#spells].filter(
        ([recipient, spell]) =>
          this.#enrollment?.notEnrolledSince(recipient) === spell.since
      ).length,
    };
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
 * One recorded start that a recovery sweep did not recover.
 * `foreign-execution`: the workflow ID is held by an execution on another
 * task queue, another deployment's, as raised by the port's start or presence
 * check for that ID. `quarantined`: an operator quarantined the record
 * (`quarantine` says who, when and why; `error` is undefined), so recovery
 * left it alone. `failed`: any other failure for this record, including a
 * PostgreSQL error, another workflow type under the ID on this deployment's
 * own queue, and a conflict raised by any later step.
 */
export interface SupervisorMessageV2RecoveryFailure {
  error: unknown;
  kind: "failed" | "foreign-execution" | "quarantined";
  quarantine?: SupervisorMessageV2RecoveryQuarantine;
  recipient: string;
  workflowId: string;
}

/** An operator's quarantine of one recorded start: who, when and why. */
export interface SupervisorMessageV2RecoveryQuarantine {
  at: string;
  by: string;
  reason: string;
}

/** A recorded start that recovery converges. */
export interface SupervisorMessageV2RecoverableStart {
  input: SupervisorMessageV2Input;
  trustedScope: TrustedSupervisorMessageV2Scope;
  workflowId: string;
}

/** A recorded start an operator quarantined: recovery leaves it alone. */
export interface SupervisorMessageV2QuarantinedStart {
  quarantine: SupervisorMessageV2RecoveryQuarantine;
  /** The message's recipient, or SUPERVISOR_MESSAGE_V2_UNREADABLE_RECIPIENT. */
  recipient: string;
  workflowId: string;
}

/** The recipient named for a recorded start whose row cannot be read. */
export const SUPERVISOR_MESSAGE_V2_UNREADABLE_RECIPIENT =
  "an unreadable recipient";

/**
 * A ledger raises this when one recorded start cannot even be listed for
 * recovery (an unreadable or wrongly bound row). It fails the whole sweep;
 * at service start it is refused like a failed record, naming the workflow
 * so an operator can quarantine it.
 */
export class SupervisorMessageV2RecoveryRecordError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string, message: string) {
    super(message);
    this.name = "SupervisorMessageV2RecoveryRecordError";
    this.workflowId = workflowId;
  }
}

/** A failure of one record, before the sweep names its record. */
type RecordFailure = Pick<SupervisorMessageV2RecoveryFailure, "error" | "kind">;

/**
 * Only the port's refusal of an execution on another task queue means another
 * deployment holds the ID. Any other conflict, including another workflow
 * type under the ID on this deployment's own queue, is this deployment's own
 * failure and is never skipped.
 */
const isForeignExecution = (error: unknown): boolean =>
  error instanceof WorkflowForeignExecutionError;

const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** One shell word: as is when it is plain, else single-quoted. */
const shellWord = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.split("'").join("'\\''")}'`;

const operatorCommand = (
  subcommand: "v2-quarantine" | "v2-quarantine-release",
  workflowId: string,
  configPath: string | undefined
): string =>
  `loop orchestration ${subcommand} ${
    configPath === undefined ? "<config-path>" : shellWord(configPath)
  } ${shellWord(workflowId)} --reason '<why>'`;

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
 * Recovery never skips such a record by itself (owner decision 7); the
 * message names each one with the exact command that quarantines it, the
 * operator's explicit escape.
 */
export class SupervisorMessageV2RecoveryStartupError extends Error {
  readonly failures: readonly SupervisorMessageV2RecoveryFailure[];

  constructor(
    failures: readonly SupervisorMessageV2RecoveryFailure[],
    operatorConfigPath?: string
  ) {
    super(
      `V2 initial recovery failed for ${plural(failures.length, "recorded start")}: ${failures
        .map(
          (failure) =>
            `${recordText(failure)}: ${recoveryFailureText(failure.error)} [to start without it: ${operatorCommand("v2-quarantine", failure.workflowId, operatorConfigPath)}]`
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
  /**
   * The host's config file, named in the quarantine and release commands the
   * runner prints. Absent, the commands say `<config-path>`.
   */
  operatorConfigPath?: string;
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
 * Service start: only a record whose ID is held by another deployment's
 * execution is skipped (logged with its ID and recipient), so a foreign
 * deployment cannot keep this host down. Any other per-record failure refuses
 * startup, naming every failing record and the command that quarantines it,
 * after every other record was recovered; the refusal is logged too, since a
 * host may wrap the error. So does a failure of the whole sweep.
 *
 * Quarantine: a record an operator quarantined is left alone and logged,
 * with who, when, why and the release command, on every start and whenever
 * it changes; its release is logged and it is recovered normally again.
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
  readonly #operatorConfigPath: string | undefined;
  /** workflowId -> its quarantine line and recipient, while quarantined. */
  readonly #quarantined = new Map<
    string,
    { line: string; recipient: string }
  >();
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
    this.#operatorConfigPath = options.operatorConfigPath;
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
      const recovered = await run.catch((error: unknown) => {
        // One unreadable row fails the whole sweep; at start it is refused
        // like a failed record, by its workflow ID.
        if (
          initial &&
          error instanceof SupervisorMessageV2RecoveryRecordError
        ) {
          throw this.#refuseStart([
            {
              error,
              kind: "failed",
              recipient: SUPERVISOR_MESSAGE_V2_UNREADABLE_RECIPIENT,
              workflowId: error.workflowId,
            },
          ]);
        }
        throw error;
      });
      this.#reportSkips(
        failures.filter((failure) => failure.kind === "foreign-execution")
      );
      this.#reportQuarantines(
        failures.filter((failure) => failure.kind === "quarantined")
      );
      const failed = failures.filter((failure) => failure.kind === "failed");
      if (initial && failed.length > 0) {
        throw this.#refuseStart(failed);
      }
      this.#retryLater(failed, now, recorded, attempted);
      return recovered;
    } finally {
      if (this.#inFlight === run) {
        this.#inFlight = undefined;
      }
    }
  }

  /** The startup refusal, logged as well: a host may wrap the error. */
  #refuseStart(
    failed: readonly SupervisorMessageV2RecoveryFailure[]
  ): SupervisorMessageV2RecoveryStartupError {
    const refusal = new SupervisorMessageV2RecoveryStartupError(
      failed,
      this.#operatorConfigPath
    );
    this.#log(refusal.message);
    return refusal;
  }

  /**
   * A quarantined record is not recovered and not retried. It is logged
   * (who, when, why, and how to release it) when this runner first sees it,
   * which is every service start, and again only when its quarantine
   * changes. Its release is logged once; it is then recovered as any other.
   */
  #reportQuarantines(
    quarantined: readonly SupervisorMessageV2RecoveryFailure[]
  ): void {
    const current = new Set(quarantined.map((failure) => failure.workflowId));
    for (const [workflowId, held] of this.#quarantined) {
      if (!current.has(workflowId)) {
        this.#quarantined.delete(workflowId);
        this.#log(
          `V2 recovery quarantine of workflow ${workflowId} for ${held.recipient} was released; recovering it again`
        );
      }
    }
    for (const failure of quarantined) {
      this.#failing.delete(failure.workflowId);
      const line = `V2 recovery QUARANTINED ${recordText(failure)}: skipped until released (quarantined by ${failure.quarantine?.by} at ${failure.quarantine?.at}: ${failure.quarantine?.reason}); release it with: ${operatorCommand("v2-quarantine-release", failure.workflowId, this.#operatorConfigPath)}`;
      if (this.#quarantined.get(failure.workflowId)?.line !== line) {
        this.#quarantined.set(failure.workflowId, {
          line,
          recipient: failure.recipient,
        });
        this.#log(line);
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
  /**
   * This deployment's recorded starts, in a stable order. A start an
   * operator quarantined is listed as such, with who, when and why, and
   * without its input: recovery leaves it alone until it is released.
   */
  recoverableStarts(): Promise<
    readonly (
      | SupervisorMessageV2RecoverableStart
      | SupervisorMessageV2QuarantinedStart
    )[]
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
   * already recorded keeps the id it was recorded under, legacy or
   * deployment-scoped; any other resolves to the id of the format the ledger
   * writes (operator-controlled: legacy unless deployment was opted in).
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
    if (name === "recovery_status") {
      // status and delivery_pending in one answer: the recovery sweep asks
      // both of every open message on every sweep. A query only; no history.
      return {
        deliveryPending:
          state.phase === "routed" && state.deliveryStatus === "pending",
        status: projectionOf({ ...state, ...scope }),
      };
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

/**
 * The first delivery attempts started after their sends were answered, one
 * per workflow at a time. Every coordinator of one service shares one, so
 * the service can let them settle before it closes the stores and engine
 * client under them. Not a scheduler: it starts nothing on its own, and an
 * attempt it never sees finish is the recovery sweep's to converge.
 */
export class SupervisorMessageV2DeliveryAttempts {
  /** workflowId -> its attempt in flight. */
  readonly #inFlight = new Map<string, Promise<void>>();

  /** Starts `attempt` unless one for the workflow is already in flight. */
  run(workflowId: string, attempt: () => Promise<void>): void {
    if (this.#inFlight.has(workflowId)) {
      return;
    }
    const running = attempt().finally(() => {
      this.#inFlight.delete(workflowId);
    });
    this.#inFlight.set(workflowId, running);
  }

  /** Resolves once every attempt, including any started meanwhile, settled. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled(this.#inFlight.values());
    }
  }

  /** idle(), or `boundMs` elapsed, whichever is first. */
  settle(boundMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

export interface SupervisorMessageV2CoordinatorOptions {
  /** Shared with every coordinator of one service; omitted, its own. */
  attempts?: SupervisorMessageV2DeliveryAttempts;
  /** Where a failed background attempt is reported; omitted, stderr. */
  log?: (line: string) => void;
}

export class SupervisorMessageV2Coordinator {
  readonly #delivery: SupervisorMessageV2DeliveryPort;
  readonly #dispatchOwner: string;
  readonly #ledger: SupervisorMessageV2DeliveryLedger;
  readonly #leaseMs: number;
  readonly #notEnrolled: SupervisorMessageV2NotEnrolledDeferral;
  readonly #now: () => Date;
  readonly #readiness: SupervisorMessageV2DeliveryReadinessPort | undefined;
  readonly #readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
  readonly #workflows: WorkflowPort;
  /** First delivery attempts started after their sends were answered. */
  readonly #attempts: SupervisorMessageV2DeliveryAttempts;
  readonly #log: (line: string) => void;

  constructor(
    workflows: WorkflowPort,
    delivery: SupervisorMessageV2DeliveryPort,
    ledger: SupervisorMessageV2DeliveryLedger,
    dispatchOwner: string,
    now: () => Date = () => new Date(),
    readiness?: SupervisorMessageV2DeliveryReadinessPort,
    readinessOutage?: SupervisorMessageV2ReadinessOutageTracker,
    notEnrolled?: SupervisorMessageV2NotEnrolledDeferral,
    options: SupervisorMessageV2CoordinatorOptions = {}
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
    // Without an enrollment port no recipient is ever "not enrolled".
    this.#notEnrolled =
      notEnrolled ?? new SupervisorMessageV2NotEnrolledDeferral();
    this.#workflows = workflows;
    this.#attempts =
      options.attempts ?? new SupervisorMessageV2DeliveryAttempts();
    this.#log = options.log ?? ((line) => console.error(line));
  }

  async receive(
    trustedScope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input,
    requestId: string
  ): Promise<SupervisorMessageV2ReceiveResult> {
    const parsed = parseSupervisorMessageV2Input(input, trustedScope);
    // The ledger resolves the id: a dedupe key accepted before a format
    // change keeps the id it was accepted under, so the message is never
    // started twice.
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
    // A new execution's start result is its current state; an adopted one
    // (a sender retry) may have moved on, so it is read.
    const projection =
      started.created && isV2Projection(started.result)
        ? started.result
        : await this.status(trustedScope, workflowId);
    // The message is durably accepted: its intent is in the ledger and its
    // execution runs. The sender's answer waits for nothing more. The first
    // delivery attempt runs after it, under the same fenced lease as every
    // recovery attempt, so a sender retry or a sweep that meets it in flight
    // cannot deliver twice, and an attempt this process never finishes is
    // the recovery sweep's to converge.
    this.#attemptInBackground(
      trustedScope,
      workflowId,
      `${requestId}:delivery`
    );
    return { created: started.created, projection, workflowId };
  }

  /**
   * Resolves once every delivery attempt started after a send's answer has
   * settled, including any started while waiting. For orderly shutdown and
   * tests; the durable recovery sweep does not depend on it.
   */
  idle(): Promise<void> {
    return this.#attempts.idle();
  }

  /**
   * One first delivery attempt per workflow in flight in this process. Its
   * failure has no sender to reach (the send was answered), so it is logged
   * with the workflow id; the message stays pending for recovery.
   */
  #attemptInBackground(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    requestId: string
  ): void {
    this.#attempts.run(workflowId, async () => {
      try {
        if (await this.#deliveryPending(trustedScope, workflowId)) {
          await this.#deliver(trustedScope, workflowId, requestId);
        }
      } catch (error) {
        this.#log(
          `V2 delivery attempt for workflow ${workflowId} failed after its send was answered; recovery retries it: ${
            error instanceof Error ? error.message : "unknown error"
          }`
        );
      }
    });
  }

  /**
   * Service-start recovery. The durable ledger supplies only canonical V2
   * envelopes whose earlier lease has expired, so an interrupted external
   * effect can converge without a sender replaying the original request.
   *
   * Each record is recovered on its own: one that fails does not stop the
   * others. The port's foreign-task-queue conflict when this host starts the
   * ID or checks its presence means another deployment's execution holds it;
   * that record is left alone and its failure is a `foreign-execution`. Any
   * other error (Temporal, PostgreSQL, another workflow type under the ID on
   * this deployment's own queue, a conflict from a later step) is `failed`.
   * A record an operator quarantined is not touched at all and is reported
   * as `quarantined` (before `due` is asked). With `report`, each failure is
   * handed to it and the sweep resolves; the caller decides what each kind
   * means. Without it, the first failure is thrown after every other record
   * was attempted, and a quarantined record is skipped. Reading the ledger
   * itself still fails the sweep.
   */
  async recoverPending(
    report?: (failure: SupervisorMessageV2RecoveryFailure) => void,
    due?: (workflowId: string) => boolean
  ): Promise<number> {
    let recovered = 0;
    let unreported: { error: unknown } | undefined;
    for (const record of await this.#ledger.recoverableStarts()) {
      if ("quarantine" in record) {
        // The operator's explicit escape: neither the engine nor the ledger
        // is asked anything about it until it is released.
        report?.({
          error: undefined,
          kind: "quarantined",
          quarantine: record.quarantine,
          recipient: record.recipient,
          workflowId: record.workflowId,
        });
        continue;
      }
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
    // Status and delivery_pending in one query: a delivered message waiting
    // on its recipient costs this sweep one engine query, not two.
    const { deliveryPending, projection } = await this.#recoveryStatus(
      trustedScope,
      workflowId
    );
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
    let pending = deliveryPending;
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
      // The retry changed the state the answer above described.
      pending = await this.#deliveryPending(trustedScope, workflowId);
    }
    if (!pending) {
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
    // The port only proves the execution runs on this deployment's queue, not
    // that it is a V2 message: another workflow type under the ID (running or
    // closed) answers "status" too. Its answer is never this message's state,
    // so recovery cannot record it as an outcome; it is this deployment's own
    // conflict, never a foreign execution.
    if (!isRecord(result.value) || result.value.schema !== V2_STATUS_SCHEMA) {
      throw new WorkflowError(
        "conflict",
        `workflow ${workflowId} is not a ${SUPERVISOR_MESSAGE_V2_WORKFLOW_TYPE} execution`
      );
    }
    return result.value as SupervisorMessageV2Projection;
  }

  /**
   * status() and delivery_pending from one engine query. Anything but a V2
   * answer (another workflow type under the ID does not know the query)
   * falls back to the two separate reads, so every refusal and conflict is
   * exactly the one status() gives.
   */
  async #recoveryStatus(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<{
    deliveryPending: boolean;
    projection: SupervisorMessageV2Projection;
  }> {
    await this.#ledger.assertStartIntent(workflowId, trustedScope);
    // A port may answer synchronously or throw synchronously.
    const value = await Promise.resolve()
      .then(() =>
        this.#workflows.query({
          args: { trustedScope },
          name: "recovery_status",
          workflowId,
        })
      )
      .then(
        (result) => result.value,
        () => undefined
      );
    if (
      isRecord(value) &&
      typeof value.deliveryPending === "boolean" &&
      isV2Projection(value.status)
    ) {
      return {
        deliveryPending: value.deliveryPending,
        projection: value.status,
      };
    }
    const projection = await this.status(trustedScope, workflowId);
    return {
      deliveryPending: await this.#deliveryPending(trustedScope, workflowId),
      projection,
    };
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
      // The readiness store could not answer (that says nothing about the
      // seat), or the recipient is not enrolled (its seat is down). Leave
      // the delivery pending without claiming a lease or spending one of the
      // message's attempts; the existing recovery sweep retries it. Past its
      // bound it is "unavailable" or "not-enrolled" instead: a normal
      // retryable failure.
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
              reason: readinessFailureReason(readiness),
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
    await this.#countBoundFailure(
      readiness,
      trustedScope,
      workflowId,
      envelope.target
    );
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
   * Counted only once its delivery_failed was signalled under this attempt's
   * lease, so a verdict a busy or closed claim absorbed is never counted.
   * A message an outage failed that has a retry scheduled waits on it: the
   * outage stays open for it until that retry is due. One the failure ended
   * has none.
   */
  async #countBoundFailure(
    readiness: DeliveryReadiness,
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    recipient: string
  ): Promise<void> {
    if (readiness === "unavailable") {
      this.#readinessOutage.failedAttempt(
        recipient,
        await this.#nextRetryAt(trustedScope, workflowId)
      );
    } else if (readiness === "not-enrolled") {
      this.#notEnrolled.failedAttempt();
    }
  }

  /**
   * When the message's next retry falls due. Bookkeeping only: if the engine
   * cannot say, the outage is held by its observations alone.
   */
  async #nextRetryAt(
    trustedScope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<Date | undefined> {
    try {
      const { value } = await this.#workflows.query({
        args: { trustedScope },
        name: "status",
        workflowId,
      });
      const next = (value as SupervisorMessageV2Projection).nextRetryAt;
      return next === null ? undefined : new Date(next);
    } catch {
      return undefined;
    }
  }

  /**
   * The recipient's readiness, or "deferred" while a store outage or a
   * not-enrolled recipient is within its bound.
   */
  async #readinessOf(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<DeliveryReadiness> {
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
      // The store says not ready. A recipient the enrollment sweep finds not
      // enrolled (its seat is down) waits within its bound; an enrolled one
      // spends the attempt, as before. A seat that stops while the server
      // runs counts as enrolled until the next enrollment pass finds it
      // down (about one reconciliation tick): a delivery in that window
      // spends its attempt as an ordinary unready refusal.
      const notEnrolled = this.#notEnrolled.unready(recipient, this.#now());
      if (notEnrolled === "defer") {
        return "deferred";
      }
      return notEnrolled === "fail" ? "not-enrolled" : "unready";
    }
    this.#readinessOutage.answered(recipient, this.#now());
    this.#notEnrolled.ready(recipient, this.#now());
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

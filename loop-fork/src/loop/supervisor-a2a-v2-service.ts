import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import {
  PostgresA2ATaskStore,
  type PostgresA2ATaskStoreOptions,
} from "./a2a-postgres-task-store";
import { FROM_METADATA_KEY } from "./a2a-supervisor-adapter";
import {
  createSupervisorA2AAssignmentHttpHandler,
  createSupervisorA2AResultGraphStartHttpHandler,
} from "./a2a-supervisor-assignment-http";
import { WORKFLOW_IDS_METADATA_KEY } from "./a2a-supervisor-executor";
import {
  createSupervisorA2AHttpHandler,
  type SupervisorA2AAuthenticatedIdentity,
  type SupervisorA2AAuthenticator,
} from "./a2a-supervisor-http";
import {
  acceptedResultArtifactId,
  assertSupervisorA2AResultGraphTask,
  publishSupervisorA2AAcceptedResult,
  type SupervisorA2AResultArtifactTarget,
  type SupervisorA2AResultBinding,
} from "./a2a-supervisor-result";
import {
  SupervisorA2AV2Ingress,
  type SupervisorA2AV2IngressOptions,
} from "./a2a-supervisor-v2-ingress";
import {
  A2A_V2_MESSAGE_STATUS_SCHEMA,
  A2A_V2_ROUTE_ERROR_STATUS,
  A2A_V2_SESSION_RECEIPT_SCHEMA,
  type A2AV2MessageStatusResponse,
  type A2AV2RouteErrorCode,
  type A2AV2SessionOperation,
  type A2AV2SessionReceipt,
  type A2AV2SessionRequestByOperation,
  a2aV2SupervisorIngressPath,
  a2aV2TaskStateName,
  a2aV2WorkResultCompleted,
  matchA2AV2Route,
  parseA2AV2SessionRequest,
} from "./a2a-v2-routes-contract";
import { readBoundedRequestText } from "./bounded-request-body";
import {
  IN_REPLY_TO_METADATA_KEY,
  OWNER_REPLY_ONLY,
  ownerReplyOnlyResponse,
} from "./orchestration-owner-messaging";
import {
  SupervisorEndpointLeaseError,
  type SupervisorEndpointLeaseFenceRefusal,
  type SupervisorEndpointLeaseHolderSummary,
  type SupervisorEndpointLeaseReader,
  type SupervisorEndpointLeaseResolution,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  SupervisorEndpointLocatorError,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointLocatorRefused,
} from "./supervisor-endpoint-lease";
import { SUPERVISOR_ID_RE as PEER_SUPERVISOR_ID } from "./supervisor-id";
import {
  createSupervisorInboxStreamHandler,
  PostgresSupervisorInboxStore,
  type SupervisorInboxStore,
  type SupervisorInboxStreamHub,
  type SupervisorInboxStreamLimits,
} from "./supervisor-inbox-stream";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Projection,
  type SupervisorResultGraphKey,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  PostgresSupervisorMessageV2DeliveryLedger,
  type PostgresSupervisorMessageV2DeliveryLedgerOptions,
  type SupervisorMessageV2SettledResultBindingCheck,
  SupervisorMessageV2StartIntentScopeError,
  type SupervisorMessageV2UnpublishableResultBinding,
  type SupervisorMessageV2WorkflowIdFormat,
  SupervisorMessageV2WorkflowIdFormatError,
  unknownResultGraphKeyAdvice,
} from "./supervisor-message-v2-delivery-ledger";
import {
  decideSupervisorEndpointRoute,
  SUPERVISOR_ENDPOINT_REASONS,
  type SupervisorEndpointDeliveryPort,
  supervisorEndpointUndeliverable,
} from "./supervisor-message-v2-endpoint-contract";
import {
  GovernedSupervisorMessageV2Service,
  PostgresSupervisorMessageV2GovernanceReceiptStore,
  type SupervisorMessageV2AuthorityPort,
} from "./supervisor-message-v2-governance";
import {
  createSupervisorMessageV2RecipientHttpHandler,
  runSupervisorMessageV2RecipientLifecycle,
  type SupervisorMessageV2RecipientLifecycleCommand,
  type SupervisorMessageV2RecipientLifecycleOutcome,
} from "./supervisor-message-v2-http";
import {
  createSupervisorMessageV2RecipientAssignmentResolver,
  createSupervisorMessageV2RecipientReachability,
  type SupervisorMessageV2RecipientEndpoints,
} from "./supervisor-message-v2-recipient-assignment";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  type SupervisorMessageV2DeliveryOutcome,
  type SupervisorMessageV2DeliveryPort,
  type SupervisorMessageV2DeliveryReadinessPort,
  SupervisorMessageV2NotEnrolledDeferral,
  type SupervisorMessageV2NotEnrolledSnapshot,
  type SupervisorMessageV2ReadinessOutageSnapshot,
  SupervisorMessageV2ReadinessOutageTracker,
  SupervisorMessageV2ReadinessUnavailableError,
  type SupervisorMessageV2RecipientEnrollmentPort,
} from "./supervisor-message-v2-runtime";
import {
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
  type SupervisorSessionProviderReadinessPort,
  type SupervisorSessionRebindAuthorityPort,
} from "./supervisor-session-v2";
import { SupervisorSessionV2DagAdapter } from "./supervisor-session-v2-dag-adapter";
import { TASK_GRAPH_WORKFLOW_TYPE } from "./task-graph-workflow";
import {
  TemporalSupervisorRuntimeHost,
  type TemporalSupervisorRuntimeOptions,
} from "./temporal-supervisor-runtime";
import { TemporalWorkflowPort } from "./temporal-workflow-port";
import type {
  JsonObject,
  WorkflowPort,
  WorkflowStartReceipt,
} from "./workflow-port";

/** Terminal A2A states in which a task can never accept a result, so the
 * graph task it reserved may pass to another A2A task. */
const ENDED_WITHOUT_RESULT: readonly TaskState[] = [
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_REJECTED,
];
const validatePeerRoute = (
  peer: { pathname: string; supervisorId: string },
  reserved: readonly (string | undefined)[]
): void => {
  if (
    !peer.pathname.startsWith("/") ||
    reserved.includes(peer.pathname) ||
    !PEER_SUPERVISOR_ID.test(peer.supervisorId)
  ) {
    throw new Error("Peer A2A route is invalid or collides");
  }
};

type TaskStoreResource = TaskStore & {
  close(): Promise<void>;
  migrate(): Promise<void>;
};

type LedgerResource = SupervisorMessageV2DeliveryLedger & {
  bindResult?: PostgresSupervisorMessageV2DeliveryLedger["bindResult"];
  resultBinding?: PostgresSupervisorMessageV2DeliveryLedger["resultBinding"];
  recipientAssignment?: PostgresSupervisorMessageV2DeliveryLedger["recipientAssignment"];
  unpublishableResultBindings?: PostgresSupervisorMessageV2DeliveryLedger["unpublishableResultBindings"];
  recoveryQuarantines?: PostgresSupervisorMessageV2DeliveryLedger["recoveryQuarantines"];
  /** The format `migrate` resolved new messages to be written in. */
  readonly workflowIdFormat?: PostgresSupervisorMessageV2DeliveryLedger["workflowIdFormat"];
  previousKeyResultBindings?: PostgresSupervisorMessageV2DeliveryLedger["previousKeyResultBindings"];
  unboundPreviousKeyResultGraphs?: PostgresSupervisorMessageV2DeliveryLedger["unboundPreviousKeyResultGraphs"];
  close(): Promise<void>;
  migrate(): Promise<void>;
};

/** ra1's inbox store as this service owns it. */
type InboxResource = SupervisorInboxStore & {
  close(): Promise<void>;
  migrate?(): Promise<void>;
};

/** T1's lease store as this service owns it. */
type LeaseResource = SupervisorEndpointLeaseStore & {
  close(): Promise<void>;
  migrate?(): Promise<void>;
};

type SessionResource = Pick<
  PostgresSupervisorSessionV2Store,
  | "assertReady"
  | "close"
  | "current"
  | "migrate"
  | "rebind"
  | "register"
  | "status"
>;

/**
 * Narrow construction seam for focused failure-cleanup proof. It is not a
 * second service protocol: production uses the default direct PostgreSQL and
 * Temporal constructors below.
 */
export interface SupervisorA2AV2ServiceDependencies {
  /**
   * r9: T1's endpoint lease store, constructed with the server's own locator
   * resolver. Absent (until T1 is wired), the session routes answer 503
   * `v2-unavailable` and no recipient has a lease row.
   */
  /**
   * ra1: the durable inbox the inbox-stream kind delivers into and the
   * stream route reads. Absent, the stream route answers 503 and an
   * inbox-stream lease is never ready.
   */
  connectInbox?(databaseUrl: string): Promise<InboxResource>;
  connectLeases?(input: {
    databaseUrl: string;
    now: () => string;
    resolveLocator: SupervisorEndpointLocatorResolver;
    /**
     * The opened (and migrated) session store: the lease store shares its
     * connection, descriptor table and rebind authority, so a claim's
     * descriptor register/rebind is decided by the same authority.
     */
    sessions: SessionResource &
      Partial<Pick<PostgresSupervisorSessionV2Store, "endpointLeases">>;
  }): Promise<LeaseResource>;
  /**
   * `options.deployment` is the workflow-id discriminator: the host's Temporal
   * task queue, the same deployment discriminator its workflow port enforces.
   */
  connectLedger(
    databaseUrl: string,
    options: PostgresSupervisorMessageV2DeliveryLedgerOptions
  ): Promise<LedgerResource>;
  connectSessions(input: {
    authority: SupervisorSessionRebindAuthorityPort;
    databaseUrl: string;
    now: () => string;
    provider: SupervisorSessionProviderReadinessPort;
  }): Promise<SessionResource>;
  connectTaskStore(
    options: PostgresA2ATaskStoreOptions
  ): Promise<TaskStoreResource>;
  createHost(
    options: TemporalSupervisorRuntimeOptions
  ): Promise<TemporalSupervisorRuntimeHost>;
  createWorkflows(client: unknown, taskQueue: string): WorkflowPort;
}

export const defaultSupervisorA2AV2ServiceDependencies: SupervisorA2AV2ServiceDependencies =
  {
    connectInbox: (databaseUrl) =>
      PostgresSupervisorInboxStore.connect(databaseUrl),
    connectLedger: (databaseUrl, options) =>
      PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl, options),
    connectSessions: (input) => PostgresSupervisorSessionV2Store.connect(input),
    connectTaskStore: (options) => PostgresA2ATaskStore.connect(options),
    createHost: (options) => TemporalSupervisorRuntimeHost.create(options),
    createWorkflows: (client, taskQueue) =>
      new TemporalWorkflowPort(client, { taskQueue }),
  };

export interface SupervisorA2AV2ServiceOptions {
  /**
   * r9: every configured supervisor as a recipient: its SDK ingress at
   * {routePath}/supervisors/<slug>, the session routes, the sender's message
   * status, and lease-aware delivery and readiness. Absent, exactly r8.
   */
  allSupervisors?: SupervisorA2AV2AllSupervisorsOptions;
  assignmentRoute?: { pathname: string; principal: string };
  card: SupervisorA2AV2IngressOptions["card"];
  databaseUrl: string;
  delivery: SupervisorMessageV2DeliveryPort;
  /** Test-only override for partial-construction cleanup proof. */
  dependencies?: SupervisorA2AV2ServiceDependencies;
  dispatchOwner: string;
  /**
   * Registers, renews, or rebinds configured session descriptors through the
   * governed session store before the runtime host starts ingress recovery.
   * Recovery checks readiness for every pending delivery, so a descriptor that
   * expired, or a seat that restarted, while the service was down must be
   * current before that first sweep. A failure refuses start.
   */
  enrollSessions?(
    sessions: SupervisorA2AV2SessionEnrollmentPort
  ): Promise<void>;
  /** Existing V1 host dependencies. The factory adds the strict V2 pair. */
  host: Omit<
    TemporalSupervisorRuntimeOptions,
    "v2Ingress" | "v2Recovery" | "v2SessionGates" | "workflowPort"
  >;
  /** Operator log for start-time findings. Lines carry ids, never secrets
   * or connection strings. Defaults to standard error. */
  log?: (line: string) => void;
  /** Explicit body-free policy boundary. Absence exposes no lifecycle authority. */
  messageAuthority?: SupervisorMessageV2AuthorityPort;
  /**
   * How long a recipient that `recipientEnrollment` reports not enrolled may
   * defer its deliveries before each one fails as a normal retryable
   * attempt. Omitted, SUPERVISOR_MESSAGE_V2_NOT_ENROLLED_BOUND_MS.
   */
  notEnrolledBoundMs?: number;
  now: () => string;
  /** The host's config file, named in the recovery quarantine commands an
   * operator is told to run. */
  operatorConfigPath?: string;
  peerRoutes?: readonly { pathname: string; supervisorId: string }[];
  policy: SupervisorA2AV2IngressOptions["policy"];
  /** Keys this host held before `resultGraphKey` (a rotation): bindings
   * derived under them still publish; nothing new is derived under them. */
  previousResultGraphKeys?: readonly SupervisorResultGraphKey[];
  providerReadiness: SupervisorSessionProviderReadinessPort;
  /**
   * How long a session readiness-store outage may defer a recipient's
   * deliveries before each one fails as a normal retryable attempt. Omitted,
   * SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS.
   */
  readinessOutageBoundMs?: number;
  rebindAuthority: SupervisorSessionRebindAuthorityPort;
  /**
   * The host's own enrollment of its seats: which are not enrolled now, and
   * since when. Every delivery path defers a not-enrolled recipient within
   * the bound; the authenticated assignment status lists the seat ids.
   * Omitted, no recipient is ever treated as not enrolled.
   */
  recipientEnrollment?: SupervisorMessageV2RecipientEnrollmentPort & {
    notEnrolled(): readonly string[];
  };
  recipientRoute?: {
    authenticator: SupervisorA2AAuthenticator;
    pathname: string;
    principalForRecipient(recipient: string): string | undefined;
  };
  recoveryIntervalMs?: number;
  /** The host secret keying result graph ids (read by the server from an
   * operator-named environment variable). Absent, no result can be bound
   * and no result graph can be started; bindings recorded under the unkeyed
   * v2 id before the key still publish. */
  resultGraphKey?: SupervisorResultGraphKey;
  /** Authenticated control-principal route that starts a message's result
   * graph under its keyed id. */
  resultGraphRoute?: { pathname: string; principal: string };
  /** Host-owned allowlist of the graph tasks this host's single route tenant
   * may bind results to (the operator's result artifact configuration). It
   * narrows, and never widens, the rule that a message binds only to its own
   * message-derived graph. Absent, no result can be bound. */
  resultGraphTasks?: readonly SupervisorA2AResultArtifactTarget[];
  route: {
    authenticator: SupervisorA2AAuthenticator;
    /**
     * r9: false when the config names no r8 recipient. The primary ingress
     * still owns recovery; only its HTTP route is not served.
     */
    mounted?: boolean;
    pathname?: string;
    tenant: string;
  };
  supervisorId: string;
  /** True only when `reference` is verified evidence for exactly `target`. */
  verifyResultArtifact?(
    reference: string,
    target: SupervisorA2AResultArtifactTarget
  ): Promise<boolean>;
  /**
   * The workflow id format new messages are written in (operator config
   * `a2aV2.workflowIdFormat`). Omitted, the format the ledger database
   * records, or `legacy`; `deployment` is an explicit opt-in.
   */
  workflowIdFormat?: SupervisorMessageV2WorkflowIdFormat;
}

/** The governed session-store operations available to start-time enrollment. */
export interface SupervisorA2AV2SessionEnrollmentPort
  extends Pick<
    SupervisorA2AV2Service,
    "currentSession" | "rebindSession" | "registerSession"
  > {
  /** r9: the lease store, when one is wired, for the lease sweep. */
  endpointLeases?: Pick<
    SupervisorEndpointLeaseStore,
    "list" | "release" | "renew" | "resolve"
  >;
  /** r9: T2's per-kind readiness probe, when it is wired. */
  endpointReadiness?: SupervisorEndpointDeliveryPort["readiness"];
}

export interface SupervisorA2AV2Service {
  /**
   * r9: every route `matchA2AV2Route(routePath, pathname)` matches (sessions,
   * per-supervisor ingress, message status). Absent without allSupervisors.
   */
  allSupervisorsRoute?: {
    httpHandler(request: Request): Promise<Response>;
    routePath: string;
  };
  assignmentRoute?: {
    pathname: string;
    httpHandler(request: Request): Promise<Response>;
  };
  bindResult(
    scope: TrustedSupervisorMessageV2Scope,
    binding: SupervisorA2AResultBinding
  ): Promise<void>;
  close(): Promise<void>;
  currentSession(
    scope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionDescriptorV2 | undefined>;
  /** Recipient acknowledgement is not task/result completion. */
  governance: GovernedSupervisorMessageV2Service | undefined;
  host: TemporalSupervisorRuntimeHost;
  httpHandler: (request: Request) => Promise<Response>;
  /** Not-enrolled deferral counters of every V2 delivery path. */
  notEnrolledDeferral(): SupervisorMessageV2NotEnrolledSnapshot;
  pathname: string;
  pathnames?: readonly string[];
  publishResult(
    scope: TrustedSupervisorMessageV2Scope,
    input: { workflowId: string; taskId: string; recipient: string }
  ): Promise<void>;
  /** Readiness-outage deferral counters of every V2 delivery path. */
  readinessOutage(): SupervisorMessageV2ReadinessOutageSnapshot;
  rebindSession(
    scope: TrustedSupervisorMessageV2Scope,
    descriptor: SupervisorSessionDescriptorV2
  ): ReturnType<PostgresSupervisorSessionV2Store["rebind"]>;
  recipientRoute?: {
    pathname: string;
    httpHandler(request: Request): Promise<Response>;
    /**
     * The same claim/acknowledge as the HTTP route, for an identity the host
     * established itself rather than from a bearer: the mailbox consumption
     * reconciler acting for a supervisor whose own reader acknowledged the
     * message. Assignment, reachability and claimant rules are the route's.
     */
    lifecycle?(
      identity: SupervisorA2AAuthenticatedIdentity,
      command: SupervisorMessageV2RecipientLifecycleCommand
    ): Promise<SupervisorMessageV2RecipientLifecycleOutcome>;
  };
  registerSession(
    scope: TrustedSupervisorMessageV2Scope,
    descriptor: SupervisorSessionDescriptorV2
  ): Promise<SupervisorSessionDescriptorV2>;
  resultGraphRoute?: {
    pathname: string;
    httpHandler(request: Request): Promise<Response>;
  };
  /** Starts the one task graph this message's result may bind to, under the
   * id derived from the message with the host's result graph key. */
  startResultGraph(
    scope: TrustedSupervisorMessageV2Scope,
    command: { input: JsonObject; messageWorkflowId: string; requestId: string }
  ): Promise<{ graphWorkflowId: string; receipt: WorkflowStartReceipt }>;
}

const closeQuietly = async (
  resource: { close(): Promise<void> } | undefined
): Promise<void> => {
  await resource?.close().catch(() => undefined);
};

const safeFailureCategory = (error: unknown): string =>
  error instanceof Error &&
  [
    "WorkflowFailedError",
    "WorkflowExecutionAlreadyStartedError",
    "WorkflowNotFoundError",
    "QueryRejectedError",
    "SupervisorSessionV2Error",
    "SupervisorMessageV2RecoveryStartupError",
    "WorkflowError",
  ].includes(error.name)
    ? error.name
    : "unclassified";

/**
 * The one owned composition for an enabled A2A V2 route. It owns only its
 * PostgreSQL clients, ingress recovery, and host shutdown ordering. It never
 * starts a Bun listener, provider adapter, or session rebind endpoint; the
 * standard server supplies authentication and route exposure separately.
 */
class OwnedSupervisorA2AV2Service implements SupervisorA2AV2Service {
  readonly allSupervisorsRoute: SupervisorA2AV2Service["allSupervisorsRoute"];
  readonly assignmentRoute: SupervisorA2AV2Service["assignmentRoute"];
  readonly #workflows: WorkflowPort;
  readonly #now: () => string;
  readonly #resultGraphKey: SupervisorResultGraphKey | undefined;
  readonly #previousResultGraphKeys: readonly SupervisorResultGraphKey[];
  readonly #resultGraphTasks: readonly SupervisorA2AResultArtifactTarget[];
  readonly #verifyResultArtifact: SupervisorA2AV2ServiceOptions["verifyResultArtifact"];
  readonly recipientRoute: SupervisorA2AV2Service["recipientRoute"];
  readonly resultGraphRoute: SupervisorA2AV2Service["resultGraphRoute"];
  readonly governance: GovernedSupervisorMessageV2Service | undefined;
  readonly #receipts:
    | PostgresSupervisorMessageV2GovernanceReceiptStore
    | undefined;
  readonly host: TemporalSupervisorRuntimeHost;
  readonly httpHandler: (request: Request) => Promise<Response>;
  readonly pathname: string;
  readonly pathnames: readonly string[];
  readonly #ledger: LedgerResource;
  readonly #notEnrolled: SupervisorMessageV2NotEnrolledDeferral;
  readonly #readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
  readonly #sessions: SessionResource;
  readonly #leases: LeaseResource | undefined;
  readonly #inbox: { close(): Promise<void> } | undefined;
  readonly #reachable:
    | ((
        scope: TrustedSupervisorMessageV2Scope,
        recipient: string
      ) => Promise<boolean>)
    | undefined;
  readonly #taskStore: TaskStoreResource;
  #closing: Promise<void> | undefined;

  constructor(input: {
    allSupervisorsRoute?: SupervisorA2AV2Service["allSupervisorsRoute"];
    assignmentRoute?: SupervisorA2AV2Service["assignmentRoute"];
    /** ra1: the inbox (detaches the hub, ending its streams, then closes). */
    inbox?: { close(): Promise<void> };
    leases?: LeaseResource;
    /** r9: the recipient route's reachability rule, for publishResult. */
    reachable?(
      scope: TrustedSupervisorMessageV2Scope,
      recipient: string
    ): Promise<boolean>;
    workflows: WorkflowPort;
    now: () => string;
    previousResultGraphKeys?: readonly SupervisorResultGraphKey[];
    resultGraphKey?: SupervisorResultGraphKey;
    resultGraphRoute?: SupervisorA2AV2Service["resultGraphRoute"];
    resultGraphTasks?: readonly SupervisorA2AResultArtifactTarget[];
    verifyResultArtifact?: SupervisorA2AV2ServiceOptions["verifyResultArtifact"];
    recipientRoute?: SupervisorA2AV2Service["recipientRoute"];
    governance?: GovernedSupervisorMessageV2Service;
    receipts?: PostgresSupervisorMessageV2GovernanceReceiptStore;
    host: TemporalSupervisorRuntimeHost;
    httpHandler: (request: Request) => Promise<Response>;
    ledger: LedgerResource;
    pathname: string;
    pathnames?: readonly string[];
    notEnrolled: SupervisorMessageV2NotEnrolledDeferral;
    readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
    sessions: SessionResource;
    taskStore: TaskStoreResource;
  }) {
    this.allSupervisorsRoute = input.allSupervisorsRoute;
    this.assignmentRoute = input.assignmentRoute;
    this.#leases = input.leases;
    this.#inbox = input.inbox;
    this.#reachable = input.reachable;
    this.#workflows = input.workflows;
    this.#now = input.now;
    this.#resultGraphKey = input.resultGraphKey;
    this.#previousResultGraphKeys = input.previousResultGraphKeys ?? [];
    this.resultGraphRoute = input.resultGraphRoute;
    this.#resultGraphTasks = (input.resultGraphTasks ?? []).map((target) => ({
      graphWorkflowId: target.graphWorkflowId,
      graphTaskId: target.graphTaskId,
    }));
    this.#verifyResultArtifact = input.verifyResultArtifact;
    this.recipientRoute = input.recipientRoute;
    this.governance = input.governance;
    this.#receipts = input.receipts;
    this.host = input.host;
    this.httpHandler = input.httpHandler;
    this.pathname = input.pathname;
    this.pathnames = input.pathnames ?? [input.pathname];
    this.#ledger = input.ledger;
    this.#notEnrolled = input.notEnrolled;
    this.#readinessOutage = input.readinessOutage;
    this.#sessions = input.sessions;
    this.#taskStore = input.taskStore;
  }

  readinessOutage(): SupervisorMessageV2ReadinessOutageSnapshot {
    return this.#readinessOutage.snapshot(new Date(this.#now()));
  }

  notEnrolledDeferral(): SupervisorMessageV2NotEnrolledSnapshot {
    return this.#notEnrolled.snapshot();
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = this.#close();
    }
    return this.#closing;
  }

  async bindResult(
    scope: TrustedSupervisorMessageV2Scope,
    binding: SupervisorA2AResultBinding
  ): Promise<void> {
    if (!this.#ledger.bindResult) {
      throw new Error("Durable result binding is unavailable");
    }
    const key = this.#resultGraphKey;
    if (!key) {
      throw new Error("Result graph key is not configured");
    }
    const context = new ServerCallContext({
      tenant: scope.tenantId,
      user: { isAuthenticated: true, userName: scope.principal },
    });
    const task = await this.#taskStore.load(binding.a2aTaskId, context);
    if (
      !(
        Array.isArray(task?.metadata?.[WORKFLOW_IDS_METADATA_KEY]) &&
        task?.metadata?.[WORKFLOW_IDS_METADATA_KEY].includes(
          binding.messageWorkflowId
        )
      )
    ) {
      throw new Error("Result binding does not belong to the scoped A2A task");
    }
    // A task graph carries no tenant or message identity, so the body's graph
    // is trusted only when it is the one derived, under this host's key, from
    // this message's scoped identity. It must also be one this host
    // configured and hold this recipient's task; the ledger re-checks the
    // derivation and reserves the graph task for this one A2A task.
    if (
      binding.graphWorkflowId !==
      deriveSupervisorMessageV2ResultGraphWorkflowId(
        key,
        scope,
        binding.messageWorkflowId
      )
    ) {
      // Under a previous key the ledger accepts only a retry of the exact
      // binding it recorded (checked when it was recorded) and refuses
      // anything new with an exact error naming that key's fingerprint.
      if (
        this.#previousResultGraphKeys.some(
          (previous) =>
            binding.graphWorkflowId ===
            deriveSupervisorMessageV2ResultGraphWorkflowId(
              previous,
              scope,
              binding.messageWorkflowId
            )
        )
      ) {
        await this.#ledger.bindResult(scope, binding);
        return;
      }
      throw new Error("Result graph is not derived from this message");
    }
    if (
      !this.#resultGraphTasks.some(
        (target) =>
          target.graphWorkflowId === binding.graphWorkflowId &&
          target.graphTaskId === binding.graphTaskId
      )
    ) {
      throw new Error("Result graph task is not configured for this host");
    }
    await assertSupervisorA2AResultGraphTask({
      binding,
      workflows: this.#workflows,
    });
    await this.#ledger.bindResult(scope, binding, {
      // Another A2A task carrying this message holds the graph task. It is
      // released only once that task has ended without a result.
      releasable: async (holder) => {
        const held = await this.#taskStore.load(
          holder.a2aTaskId,
          new ServerCallContext({
            tenant: holder.tenantId,
            user: { isAuthenticated: true, userName: scope.principal },
          })
        );
        return (
          held?.status !== undefined &&
          ENDED_WITHOUT_RESULT.includes(held.status.state)
        );
      },
    });
  }

  async startResultGraph(
    scope: TrustedSupervisorMessageV2Scope,
    command: { input: JsonObject; messageWorkflowId: string; requestId: string }
  ): Promise<{ graphWorkflowId: string; receipt: WorkflowStartReceipt }> {
    const key = this.#resultGraphKey;
    if (!key) {
      throw new Error("Result graph key is not configured");
    }
    // Only a message recorded in this exact scope has a result graph here.
    await this.#ledger.assertStartIntent(command.messageWorkflowId, scope);
    const graphWorkflowId = deriveSupervisorMessageV2ResultGraphWorkflowId(
      key,
      scope,
      command.messageWorkflowId
    );
    const receipt = await this.#workflows.start({
      input: command.input,
      requestId: command.requestId,
      workflowId: graphWorkflowId,
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    });
    return { graphWorkflowId, receipt };
  }

  async publishResult(
    scope: TrustedSupervisorMessageV2Scope,
    input: { workflowId: string; taskId: string; recipient: string }
  ): Promise<void> {
    if (!(this.#ledger.resultBinding && this.#verifyResultArtifact)) {
      throw new Error("Result publication is unavailable");
    }
    const binding = await this.#ledger.resultBinding(
      scope,
      input.workflowId,
      input.taskId
    );
    if (!binding || binding.recipient !== input.recipient) {
      throw new Error("Result publication assignment denied");
    }
    if (this.#reachable) {
      // r9: the same rule as the recipient route (lease, mailbox or r8).
      if (!(await this.#reachable(scope, input.recipient))) {
        throw new Error("Result publication recipient is not reachable");
      }
    } else {
      await this.#sessions.assertReady(scope, input.recipient);
    }
    await publishSupervisorA2AAcceptedResult({
      binding,
      context: new ServerCallContext({
        tenant: scope.tenantId,
        user: { isAuthenticated: true, userName: scope.principal },
      }),
      store: this.#taskStore,
      workflows: this.#workflows,
      now: this.#now,
      verifyArtifact: this.#verifyResultArtifact,
    });
  }

  currentSession(
    scope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionDescriptorV2 | undefined> {
    return this.#sessions.current(scope, recipient);
  }

  registerSession(
    scope: TrustedSupervisorMessageV2Scope,
    descriptor: SupervisorSessionDescriptorV2
  ): Promise<SupervisorSessionDescriptorV2> {
    return this.#sessions.register(scope, descriptor);
  }

  rebindSession(
    scope: TrustedSupervisorMessageV2Scope,
    descriptor: SupervisorSessionDescriptorV2
  ): ReturnType<PostgresSupervisorSessionV2Store["rebind"]> {
    return this.#sessions.rebind(scope, descriptor);
  }

  async #close(): Promise<void> {
    // The host stops ingress recovery before its worker. Only after that
    // boundary has settled may this factory release V2 session, ledger, and
    // task clients. Concurrent callers share this exact barrier.
    let failed = false;
    for (const resource of [
      this.host,
      ...(this.#receipts ? [this.#receipts] : []),
      ...(this.#inbox ? [this.#inbox] : []),
      ...(this.#leases ? [this.#leases] : []),
      this.#sessions,
      this.#ledger,
      this.#taskStore,
    ]) {
      try {
        await resource.close();
      } catch {
        failed = true;
      }
    }
    if (failed) {
      throw new Error("Supervisor A2A V2 service shutdown failed");
    }
  }
}

/** What an operator does about each kind of unpublishable binding. */
const unpublishableLine = (
  entry: SupervisorMessageV2UnpublishableResultBinding,
  hostHasKey: boolean
): string => {
  const ids = `tenant ${entry.tenantId} message ${entry.messageWorkflowId} A2A task ${entry.a2aTaskId}`;
  switch (entry.reason) {
    case "unknown-result-graph-key":
      return `A2A V2 result binding cannot publish (${entry.reason}): ${ids}; it was derived under ${
        entry.keyFingerprint
          ? `result graph key ${entry.keyFingerprint}`
          : "a result graph key recorded before key fingerprints were"
      }, which this host does not hold: ${unknownResultGraphKeyAdvice(hostHasKey)}`;
    case "lost-graph-task-reservation":
      return `A2A V2 result binding will never publish (${entry.reason}): ${ids}; it does not hold its graph task's reservation (another A2A task carrying this message holds it, or none does), and a binding to a derived graph cannot be re-bound`;
    default:
      return `A2A V2 result binding will never publish (${entry.reason}): ${ids}; re-bind it to its message-derived result graph`;
  }
};

/**
 * Whether a recorded binding needs no result graph key any more, by its A2A
 * task: the binding's result was published (the task holds the message's
 * accepted-result artifact), or the task ended without a result (failed,
 * canceled or rejected), so it can never publish. A missing task is not
 * settled. Read in the binding's own scope.
 */
const settledResultBinding =
  (taskStore: TaskStore): SupervisorMessageV2SettledResultBindingCheck =>
  async (binding, scope) => {
    const task = await taskStore.load(
      binding.a2aTaskId,
      new ServerCallContext({
        tenant: scope.tenantId,
        user: { isAuthenticated: true, userName: scope.principal },
      })
    );
    if (!task) {
      return false;
    }
    return (
      (task.status !== undefined &&
        ENDED_WITHOUT_RESULT.includes(task.status.state)) ||
      task.artifacts.some(
        (artifact) =>
          artifact.artifactId ===
          acceptedResultArtifactId(binding.messageWorkflowId)
      )
    );
  };

/**
 * Recorded bindings of this host's deployment and route tenant that do not
 * publish (a graph the request body chose before graphs were derived, an
 * unreadable row, an unkeyed binding that lost its graph task's
 * reservation, or a binding derived under a result graph key this host does
 * not hold and that has not settled), reported at every start, one line
 * each with ids and key fingerprints only, until each is resolved. Another
 * deployment's bindings, and other tenants', are never reported here.
 */
const reportUnpublishableResultBindings = async (
  ledger: LedgerResource,
  options: SupervisorA2AV2ServiceOptions,
  settled: SupervisorMessageV2SettledResultBindingCheck,
  log: (line: string) => void = (line) => console.error(line)
): Promise<void> => {
  const hostHasKey = options.resultGraphKey !== undefined;
  for (const entry of (await ledger.unpublishableResultBindings?.(
    options.route.tenant,
    { settled }
  )) ?? []) {
    log(unpublishableLine(entry, hostHasKey));
  }
};

/**
 * Configured result graphs (resultArtifacts) started under a key that is
 * now a previous key, for a message of this host's assignment scope that
 * has no binding: nothing new is bound under a previous key, so each can
 * never be bound. Reported at every start, one line each with ids and the
 * key fingerprint only, until the message is bound under the primary key.
 */
const reportUnboundPreviousKeyResultGraphs = async (
  ledger: LedgerResource,
  options: SupervisorA2AV2ServiceOptions,
  log: (line: string) => void = (line) => console.error(line)
): Promise<void> => {
  if (!(options.assignmentRoute && ledger.unboundPreviousKeyResultGraphs)) {
    return;
  }
  for (const entry of await ledger.unboundPreviousKeyResultGraphs(
    {
      tenantId: options.route.tenant,
      principal: options.assignmentRoute.principal,
    },
    (options.resultGraphTasks ?? []).map((target) => target.graphWorkflowId)
  )) {
    log(
      `A2A V2 result graph cannot be bound (started-under-previous-result-graph-key): tenant ${options.route.tenant} message ${entry.messageWorkflowId}; resultArtifacts lists its graph under previous result graph key ${entry.keyFingerprint}, no binding was recorded for the message before the rotation, and new bindings use the primary key only: start the message's result graph again under the primary key, list that graph in resultArtifacts, and bind it`
    );
  }
};

/**
 * One start line naming the workflow id format the ledger resolved. Legacy
 * ids carry no deployment discriminator, so decision 6's per-deployment
 * isolation is off until the operator opts in to "deployment". The line says
 * so: a host sharing the ledger database on another task queue then recovers
 * and deduplicates this host's messages, and this host theirs.
 */
const reportWorkflowIdFormat = (
  ledger: LedgerResource,
  log: (line: string) => void = (line) => console.error(line)
): void => {
  if (ledger.workflowIdFormat === "legacy") {
    log(
      'A2A V2 workflow ids: legacy format. The deployment discriminator is off: every host sharing this ledger database recovers and deduplicates the others\' messages. Set a2aV2.workflowIdFormat "deployment" on every such host once all of them run a build that supports it'
    );
  } else if (ledger.workflowIdFormat === "deployment") {
    log(
      "A2A V2 workflow ids: deployment format, scoped to this host's task queue"
    );
  }
};

const createAssignmentRoute = (
  options: SupervisorA2AV2ServiceOptions,
  ledger: LedgerResource,
  bind: SupervisorA2AV2Service["bindResult"],
  readinessOutage: SupervisorMessageV2ReadinessOutageTracker,
  settled: SupervisorMessageV2SettledResultBindingCheck
): SupervisorA2AV2Service["assignmentRoute"] => {
  if (!options.assignmentRoute) {
    return undefined;
  }
  if (
    [
      options.route.pathname ?? "/a2a",
      options.recipientRoute?.pathname,
      "/healthz",
    ].includes(options.assignmentRoute.pathname)
  ) {
    throw new Error("Assignment route path collides");
  }
  const list = ledger.unpublishableResultBindings?.bind(ledger);
  const quarantined = ledger.recoveryQuarantines?.bind(ledger);
  const previous = ledger.previousKeyResultBindings?.bind(ledger);
  return {
    pathname: options.assignmentRoute.pathname,
    httpHandler: createSupervisorA2AAssignmentHttpHandler({
      ...options.assignmentRoute,
      authenticator: options.route.authenticator,
      tenant: options.route.tenant,
      bind,
      // The per-seat detail that the unauthenticated /healthz only counts:
      // this host's seats that are not enrolled, and the recipients a
      // readiness-store outage defers. Control principal only.
      deliveryStatus: () => ({
        notEnrolled: [...(options.recipientEnrollment?.notEnrolled() ?? [])],
        readinessOutage: readinessOutage.recipients(new Date(options.now())),
      }),
      // The inspection surface lists only this route's tenant. Quarantined
      // recovery records are reported here, never on /healthz.
      recoveryQuarantine: quarantined
        ? (scope) => quarantined(scope.tenantId)
        : undefined,
      // Bindings that settled (published, or their A2A task ended without
      // a result) need no key: listed under neither section.
      unpublishable: list
        ? (scope) => list(scope.tenantId, { settled })
        : undefined,
      underPreviousKey: previous
        ? (scope) => previous(scope.tenantId, { settled })
        : undefined,
    }),
  };
};

const createResultGraphRoute = (
  options: SupervisorA2AV2ServiceOptions,
  start: SupervisorA2AV2Service["startResultGraph"]
): SupervisorA2AV2Service["resultGraphRoute"] => {
  if (!options.resultGraphRoute) {
    return undefined;
  }
  if (
    [
      options.route.pathname ?? "/a2a",
      options.recipientRoute?.pathname,
      options.assignmentRoute?.pathname,
      "/healthz",
    ].includes(options.resultGraphRoute.pathname)
  ) {
    throw new Error("Result graph route path collides");
  }
  return {
    pathname: options.resultGraphRoute.pathname,
    httpHandler: createSupervisorA2AResultGraphStartHttpHandler({
      ...options.resultGraphRoute,
      authenticator: options.route.authenticator,
      tenant: options.route.tenant,
      start,
    }),
  };
};

/* ---------------------------------------------------------------------------
 * r9: every configured supervisor as a recipient. The routes below sit under
 * `a2aV2.routePath` (see a2a-v2-routes-contract.ts); the r8 routes are
 * unchanged. Each handler takes its stores as ports, so it is tested with
 * fakes of the T1 lease store and the T2 endpoint delivery port.
 * ------------------------------------------------------------------------- */

const SESSION_BODY_MAX_BYTES = 16 * 1024;
const INGRESS_BODY_MAX_BYTES = 64 * 1024;
/** GET messages/<id> scans at most this many pages of the sender's tasks. */
const MESSAGE_STATUS_TASK_PAGES = 10;
const MESSAGE_STATUS_TASK_PAGE_SIZE = 100;

const routeJson = (
  status: number,
  value: unknown,
  headers?: HeadersInit
): Response =>
  Response.json(value, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });

const routeError = (
  code: Exclude<A2AV2RouteErrorCode, "lease-fenced" | "lease-held">,
  headers?: HeadersInit
): Response =>
  routeJson(A2A_V2_ROUTE_ERROR_STATUS[code], { error: { code } }, headers);

const isJsonRequest = (request: Request): boolean => {
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    mediaType === "application/json" || mediaType === "application/a2a+json"
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Authenticate a request, or the error response. An authenticator that
 * throws is a 500 with a fixed code; no identity is a 401.
 */
const authenticateRoute = async (
  authenticator: SupervisorA2AAuthenticator,
  request: Request
): Promise<SupervisorA2AAuthenticatedIdentity | Response> => {
  let identity: SupervisorA2AAuthenticatedIdentity | undefined;
  try {
    identity = await authenticator.authenticate(request);
  } catch {
    return routeError("authentication-failed");
  }
  return identity ?? routeError("unauthenticated");
};

/** The lease store as the session routes use it: absent until T1 is wired. */
export type A2AV2SessionLeaseStore = Pick<
  SupervisorEndpointLeaseStore,
  "claim" | "release" | "renew"
>;

export interface A2AV2SessionRoutesOptions {
  /** Any configured supervisor identity (the control-surface tokens). */
  authenticator: SupervisorA2AAuthenticator;
  /** Undefined when no lease store is available: every request is 503. */
  leases(): A2AV2SessionLeaseStore | undefined;
  log?: (line: string) => void;
  /**
   * ra1: a claim or release changed this recipient's lease; its open inbox
   * streams re-check their fence now (a takeover ends the old holder's).
   */
  onLeaseChange?(recipient: string): void;
  principalForRecipient(recipient: string): string | undefined;
  /** The server's own resolver; a claim's locator is resolved before the store. */
  resolveLocator: SupervisorEndpointLocatorResolver;
  /** a2aV2.sessionTtlMs, for a request that names no ttlMs. */
  sessionTtlMs: number;
  tenant: string;
}

const sessionReceipt = (
  operation: A2AV2SessionOperation,
  lease: SupervisorEndpointLeaseV2,
  extra: Pick<A2AV2SessionReceipt, "changed" | "tookOver">
): A2AV2SessionReceipt => ({
  ...extra,
  descriptorRevision: lease.descriptorRevision,
  epoch: lease.epoch,
  expiresAt: lease.expiresAt,
  holderRef: lease.holderRef,
  kind: lease.kind,
  operation,
  releasedAt: lease.releasedAt,
  schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
  supervisorId: lease.recipient,
});

/** A store rejection: never its text. */
const sessionStoreFailure = (error: unknown): Response => {
  if (error instanceof SupervisorEndpointLocatorError) {
    return routeError("locator-refused");
  }
  if (error instanceof SupervisorEndpointLeaseError) {
    return routeError("request-invalid");
  }
  return routeError("v2-unavailable");
};

/**
 * POST {routePath}/sessions/{claim,renew,release}. The bearer identity's
 * supervisorId must equal the body's, and must be the configured binding of
 * its principal. The scope is the seat's own: {tenant, principalFor(id)}.
 *
 * SECURITY: a claim's locator is untrusted ids. It is resolved here, with the
 * server's resolver for the AUTHENTICATED supervisor, before the store sees
 * it (the store resolves it again in its transaction); a refusal is 403
 * `locator-refused` with no detail. Renew re-resolves the stored locator in
 * the store, after the fence. No receipt echoes a locator.
 */
/** An authenticated, decoded, identity-bound session request. */
interface A2AV2SessionCall<O extends A2AV2SessionOperation> {
  body: A2AV2SessionRequestByOperation[O];
  leases: A2AV2SessionLeaseStore;
  recipient: string;
  scope: TrustedSupervisorMessageV2Scope;
}

/** Method, media type, bearer, body bound, strict decode and identity. */
const acceptSessionRequest = async <O extends A2AV2SessionOperation>(
  options: A2AV2SessionRoutesOptions,
  request: Request,
  operation: O
): Promise<A2AV2SessionCall<O> | Response> => {
  if (request.method !== "POST") {
    return routeError("method-not-allowed", { allow: "POST" });
  }
  if (!isJsonRequest(request)) {
    return routeError("content-type-invalid");
  }
  const identity = await authenticateRoute(options.authenticator, request);
  if (identity instanceof Response) {
    return identity;
  }
  const raw = await readBoundedRequestText(request, SESSION_BODY_MAX_BYTES);
  if (raw === undefined) {
    return routeError("body-too-large");
  }
  let body: A2AV2SessionRequestByOperation[O];
  try {
    body = parseA2AV2SessionRequest(operation, JSON.parse(raw));
  } catch {
    return routeError("request-invalid");
  }
  // The body names the authenticated supervisor, whose configured principal
  // is the authenticated one: a token acts only for its own seat.
  const principal = options.principalForRecipient(identity.supervisorId);
  if (
    body.supervisorId !== identity.supervisorId ||
    principal === undefined ||
    principal !== identity.principal
  ) {
    return routeError("identity-mismatch");
  }
  const leases = options.leases();
  if (!leases) {
    return routeError("v2-unavailable");
  }
  return {
    body,
    leases,
    recipient: identity.supervisorId,
    scope: { principal, tenantId: options.tenant },
  };
};

const leaseHeldResponse = (
  current: SupervisorEndpointLeaseHolderSummary
): Response =>
  routeJson(A2A_V2_ROUTE_ERROR_STATUS["lease-held"], {
    error: { code: "lease-held", current },
  });

const leaseFencedResponse = (
  reason: SupervisorEndpointLeaseFenceRefusal
): Response =>
  routeJson(A2A_V2_ROUTE_ERROR_STATUS["lease-fenced"], {
    error: { code: "lease-fenced", reason },
  });

const claimSession = async (
  options: A2AV2SessionRoutesOptions,
  call: A2AV2SessionCall<"claim">,
  refused: (reason: string) => Response
): Promise<Response> => {
  const { body, recipient } = call;
  // SECURITY: resolve the untrusted ids for the AUTHENTICATED supervisor
  // before the store sees them.
  try {
    options.resolveLocator(body.locator, recipient);
  } catch (error) {
    return refused(supervisorEndpointLocatorRefused(error).reason);
  }
  const result = await call.leases.claim({
    holderRef: body.holderRef,
    locator: body.locator,
    recipient,
    scope: call.scope,
    sessionRef: body.sessionRef,
    ...(body.takeover === undefined ? {} : { takeover: body.takeover }),
    ttlMs: body.ttlMs ?? options.sessionTtlMs,
  });
  if (result.status === "held") {
    return leaseHeldResponse(result.current);
  }
  if (result.status === "locator-refused") {
    return refused(result.reason);
  }
  return routeJson(
    200,
    sessionReceipt("claim", result.lease, { tookOver: result.tookOver })
  );
};

const renewSession = async (
  options: A2AV2SessionRoutesOptions,
  call: A2AV2SessionCall<"renew">,
  refused: (reason: string) => Response
): Promise<Response> => {
  const { body } = call;
  const result = await call.leases.renew({
    fence: { epoch: body.epoch, holderRef: body.holderRef },
    recipient: call.recipient,
    scope: call.scope,
    ttlMs: body.ttlMs ?? options.sessionTtlMs,
  });
  if (result.status === "fenced") {
    return leaseFencedResponse(result.reason);
  }
  if (result.status === "locator-refused") {
    return refused(result.reason);
  }
  return routeJson(200, sessionReceipt("renew", result.lease, {}));
};

const releaseSession = async (
  call: A2AV2SessionCall<"release">
): Promise<Response> => {
  const { body } = call;
  const result = await call.leases.release({
    fence: { epoch: body.epoch, holderRef: body.holderRef },
    recipient: call.recipient,
    scope: call.scope,
  });
  if (result.status === "fenced") {
    return leaseFencedResponse(result.reason);
  }
  return routeJson(
    200,
    sessionReceipt("release", result.lease, { changed: result.changed })
  );
};

/**
 * POST {routePath}/sessions/{claim,renew,release}. The bearer identity's
 * supervisorId must equal the body's, and must be the configured binding of
 * its principal. The scope is the seat's own: {tenant, principalFor(id)}.
 *
 * SECURITY: a claim's locator is untrusted ids. It is resolved here, with the
 * server's resolver for the AUTHENTICATED supervisor, before the store sees
 * it (the store resolves it again in its transaction); a refusal is 403
 * `locator-refused` with no detail. Renew re-resolves the stored locator in
 * the store, after the fence. No receipt echoes a locator.
 */
export const createA2AV2SessionRoutesHandler = (
  options: A2AV2SessionRoutesOptions
): ((
  request: Request,
  operation: A2AV2SessionOperation
) => Promise<Response>) => {
  const log = options.log ?? ((line: string) => console.error(line));
  return async (request, operation) => {
    const call = await acceptSessionRequest(options, request, operation);
    if (call instanceof Response) {
      return call;
    }
    // The reason is for the operator's log only; the caller learns nothing.
    const refused = (reason: string): Response => {
      log(
        `A2A V2 session ${operation} refused for ${call.recipient}: locator ${reason}`
      );
      return routeError("locator-refused");
    };
    let response: Response;
    try {
      if (operation === "claim") {
        response = await claimSession(
          options,
          call as A2AV2SessionCall<"claim">,
          refused
        );
      } else if (operation === "renew") {
        return await renewSession(
          options,
          call as A2AV2SessionCall<"renew">,
          refused
        );
      } else {
        response = await releaseSession(call as A2AV2SessionCall<"release">);
      }
    } catch (error) {
      return sessionStoreFailure(error);
    }
    if (response.ok) {
      options.onLeaseChange?.(call.recipient);
    }
    return response;
  };
};

/**
 * A `receive` decision for the ingress: allowed, refused, or (RA2)
 * `owner-reply-only`, an unprompted message to the owner, refused with a
 * body that names the attention-os interaction path.
 */
export type A2AV2ReceiveDecision = boolean | typeof OWNER_REPLY_ONLY;

export interface A2AV2ReceiveRequest {
  from: string;
  /**
   * RA2: the owner message a reply to the owner answers, from the message's
   * `harness.dev/inReplyTo` metadata, when it carries one.
   */
  inReplyTo?: string;
  /** The message's A2A message id, when it carries one. */
  messageId?: string;
  principal: string;
  /** The message's A2A context id, when it carries one. */
  threadId?: string;
  to: string;
}

export interface A2AV2SupervisorIngressGateOptions {
  /** Any configured supervisor identity. */
  authenticator: SupervisorA2AAuthenticator;
  /**
   * The configured grants: may this principal, as `from`, send to `to`
   * (operation `receive`) on this context? Only `true` allows.
   */
  mayReceive(input: A2AV2ReceiveRequest): A2AV2ReceiveDecision;
}

/** The SDK methods that carry a message to the path's supervisor. */
const SENDING_METHODS = new Set(["SendMessage", "SendStreamingMessage"]);

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/**
 * `harness.dev/from`, the context id, the message id and (RA2) the
 * `harness.dev/inReplyTo` owner message of the message a JSON-RPC request
 * sends, if it sends.
 */
const sentFrom = (
  parsed: unknown
):
  | {
      contextId?: string;
      from: unknown;
      inReplyTo?: string;
      messageId?: string;
      sends: true;
    }
  | { sends: false } => {
  if (!isPlainRecord(parsed)) {
    return { sends: false };
  }
  const params = isPlainRecord(parsed.params) ? parsed.params : undefined;
  if (!(SENDING_METHODS.has(String(parsed.method)) || params?.message)) {
    return { sends: false };
  }
  const message = isPlainRecord(params?.message) ? params.message : undefined;
  const metadata = isPlainRecord(message?.metadata)
    ? message.metadata
    : undefined;
  const contextId = nonBlank(message?.contextId);
  const messageId = nonBlank(message?.messageId);
  const inReplyTo = nonBlank(metadata?.[IN_REPLY_TO_METADATA_KEY]);
  return {
    ...(contextId ? { contextId } : {}),
    from: metadata?.[FROM_METADATA_KEY],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(messageId ? { messageId } : {}),
    sends: true,
  };
};

const parseJsonOrUndefined = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // The SDK answers a parse error itself.
    return undefined;
  }
};

/**
 * The refusal of a request that sends, or undefined to let it through: the
 * sender must be the authenticated supervisor and the grant must hold
 * (only `true` allows). RA2: an unprompted message to the owner is refused
 * with the body that names the attention-os interaction path.
 */
const ingressSendRefusal = (
  options: A2AV2SupervisorIngressGateOptions,
  sent: ReturnType<typeof sentFrom>,
  identity: SupervisorA2AAuthenticatedIdentity,
  to: string
): Response | undefined => {
  if (!sent.sends) {
    return undefined;
  }
  if (sent.from !== identity.supervisorId) {
    return routeError("identity-mismatch");
  }
  const decision = options.mayReceive({
    from: identity.supervisorId,
    ...(sent.inReplyTo ? { inReplyTo: sent.inReplyTo } : {}),
    ...(sent.messageId ? { messageId: sent.messageId } : {}),
    principal: identity.principal,
    ...(sent.contextId ? { threadId: sent.contextId } : {}),
    to,
  });
  if (decision === OWNER_REPLY_ONLY) {
    return ownerReplyOnlyResponse();
  }
  return decision === true ? undefined : routeError("identity-mismatch");
};

/**
 * The gate in front of one supervisor's SDK ingress: it authenticates any
 * configured identity, then requires every message the request carries to
 * name the AUTHENTICATED supervisor in `harness.dev/from` and a configured
 * `receive` grant for {principal, from, to}. A refusal is 403
 * `identity-mismatch` and the SDK never sees the request. The SDK handler is
 * then given the same identity, not a second authentication.
 */
export const createA2AV2SupervisorIngressGate = (
  options: A2AV2SupervisorIngressGateOptions
): ((
  request: Request,
  to: string,
  sdk: (
    request: Request,
    identity?: SupervisorA2AAuthenticatedIdentity
  ) => Promise<Response>
) => Promise<Response>) => {
  return async (request, to, sdk) => {
    if (request.method !== "POST" || !isJsonRequest(request)) {
      // The SDK adapter answers 405 or 415 before it would authenticate.
      return sdk(request);
    }
    const identity = await authenticateRoute(options.authenticator, request);
    if (identity instanceof Response) {
      return identity;
    }
    const raw = await readBoundedRequestText(request, INGRESS_BODY_MAX_BYTES);
    if (raw === undefined) {
      return routeError("body-too-large");
    }
    const parsed = parseJsonOrUndefined(raw);
    if (Array.isArray(parsed)) {
      // A batch is not a request this ingress serves.
      return routeError("request-invalid");
    }
    const refusal = ingressSendRefusal(options, sentFrom(parsed), identity, to);
    if (refusal) {
      return refusal;
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return sdk(
      new Request(request.url, { body: raw, headers, method: request.method }),
      identity
    );
  };
};

export interface A2AV2MessageStatusOptions {
  authenticator: SupervisorA2AAuthenticator;
  /**
   * The message's projection in exactly this scope, or undefined when it is
   * absent there (absent, or another tenant's or principal's: never told
   * apart).
   */
  status(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<
    | Pick<
        SupervisorMessageV2Projection,
        "acknowledgedAt" | "deliveredAt" | "phase" | "to"
      >
    | undefined
  >;
  /** The SDK task state of the A2A task carrying the message, if any. */
  taskState(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<TaskState | undefined>;
  tenant: string;
}

/**
 * GET {routePath}/messages/<messageId>, where the id is the message workflow
 * id the A2A task carries in `harness.dev/workflowId`. Answers only within
 * {route tenant, authenticated principal}: the sender's own messages. Any
 * other id is 404, indistinguishable from an absent one. Delivery, the
 * recipient's read ACK and completion stay three separate facts.
 */
export const createA2AV2MessageStatusHandler = (
  options: A2AV2MessageStatusOptions
): ((request: Request, messageId: string) => Promise<Response>) => {
  return async (request, messageId) => {
    if (request.method !== "GET") {
      return routeError("method-not-allowed", { allow: "GET" });
    }
    const identity = await authenticateRoute(options.authenticator, request);
    if (identity instanceof Response) {
      return identity;
    }
    const scope = { principal: identity.principal, tenantId: options.tenant };
    try {
      const projection = await options.status(scope, messageId);
      if (!projection) {
        return routeError("not-found");
      }
      const taskState = a2aV2TaskStateName(
        await options.taskState(scope, messageId)
      );
      const body: A2AV2MessageStatusResponse = {
        acknowledgedAt: projection.acknowledgedAt,
        deliveredAt: projection.deliveredAt,
        messageId,
        phase: projection.phase,
        schema: A2A_V2_MESSAGE_STATUS_SCHEMA,
        taskState,
        to: projection.to,
        workResultCompleted: a2aV2WorkResultCompleted(taskState),
      };
      return routeJson(200, body);
    } catch {
      return routeError("v2-unavailable");
    }
  };
};

/**
 * The state of the sender's A2A task that carries `workflowId`, from the
 * sender's own task scope, scanning a bounded number of pages.
 */
export const a2aV2MessageTaskState = async (
  taskStore: TaskStore,
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): Promise<TaskState | undefined> => {
  const context = new ServerCallContext({
    tenant: scope.tenantId,
    user: { isAuthenticated: true, userName: scope.principal },
  });
  let pageToken = "";
  for (let page = 0; page < MESSAGE_STATUS_TASK_PAGES; page += 1) {
    const listed = await taskStore.list(
      {
        contextId: "",
        includeArtifacts: false,
        pageSize: MESSAGE_STATUS_TASK_PAGE_SIZE,
        pageToken,
        status: TaskState.TASK_STATE_UNSPECIFIED,
        statusTimestampAfter: undefined,
        tenant: scope.tenantId,
      },
      context
    );
    const carrying = listed.tasks.find((task) => {
      const ids = task.metadata?.[WORKFLOW_IDS_METADATA_KEY];
      return Array.isArray(ids) && ids.includes(workflowId);
    });
    if (carrying) {
      return carrying.status?.state;
    }
    if (!listed.nextPageToken) {
      return undefined;
    }
    pageToken = listed.nextPageToken;
  }
  return undefined;
};

/** The r9 options of the service; absent, the service is exactly r8's. */
export interface SupervisorA2AV2AllSupervisorsOptions {
  /** Any configured supervisor identity (the control-surface tokens). */
  authenticator: SupervisorA2AAuthenticator;
  /**
   * T2's endpoint delivery and readiness, built from the store this service
   * opened. Absent: a lease-backed recipient is unready (no adapter), while
   * mailbox-held recipients are delivered through `delivery`.
   */
  endpointDelivery?(input: {
    leases: SupervisorEndpointLeaseReader;
    sessions: Pick<SessionResource, "current">;
  }): SupervisorEndpointDeliveryPort;
  hasMailbox(recipient: string): boolean;
  /**
   * ra1: the hub shared with the inbox-stream delivery adapter. With it (and
   * `dependencies.connectInbox`) the service opens the inbox and serves
   * GET {routePath}/sessions/<slug>/inbox.
   */
  inboxStream?: SupervisorInboxStreamHub;
  /** ra1: test-only stream limits. */
  inboxStreamLimits?: Partial<SupervisorInboxStreamLimits>;
  /** r8's manifest-bound seats; see SupervisorMessageV2RecipientEndpoints. */
  legacySeats: readonly string[];
  log?: (line: string) => void;
  mayReceive(input: A2AV2ReceiveRequest): A2AV2ReceiveDecision;
  /**
   * RA2: told of each message a supervisor ingress durably accepted (after
   * its V2 start intent), never by the gate before delivery.
   */
  onAccepted?: SupervisorA2AV2IngressOptions["onAccepted"];
  principalForRecipient(recipient: string): string | undefined;
  /** See SupervisorMessageV2RecipientEndpoints.renewExpiredLease. */
  renewExpiredLease?(recipient: string): Promise<boolean>;
  /** The server's own resolver (createSupervisorEndpointLocatorResolver). */
  resolveLocator: SupervisorEndpointLocatorResolver;
  routePath: string;
  sessionTtlMs: number;
  /**
   * RA2: role id -> the configured legacy address it aliases
   * (project-identity.ts `configuredSupervisorAddressBook`). Each alias also
   * gets {routePath}/supervisors/<alias slug>, served by its address.
   */
  supervisorAliases?: ReadonlyMap<string, string>;
  /** Every configured supervisor; each gets {routePath}/supervisors/<slug>. */
  supervisorIds: readonly string[];
}

/** No lease store: every recipient has no lease row. */
const NO_LEASES: SupervisorEndpointLeaseReader = {
  list: () => Promise.resolve([]),
  resolve: () => Promise.resolve({ state: "none" }),
};

/**
 * Delivery, readiness and the not-enrolled port for every configured
 * supervisor, by one rule. An r8 seat with no lease row keeps r8's path (its
 * sender-scope descriptor and the bridge-then-mailbox delivery). Every other
 * recipient follows `decideSupervisorEndpointRoute`: through T2's endpoint
 * port when it is wired, else mailbox-held recipients through the mailbox
 * delivery and lease-backed ones unready (a transient failure; never the
 * mailbox while a session holds the lease).
 */
export class SupervisorA2AV2RecipientRouting
  implements
    SupervisorMessageV2DeliveryPort,
    SupervisorMessageV2DeliveryReadinessPort,
    SupervisorMessageV2RecipientEnrollmentPort
{
  readonly #endpoint: SupervisorEndpointDeliveryPort | undefined;
  readonly #enrollment: SupervisorMessageV2RecipientEnrollmentPort | undefined;
  readonly #hasMailbox: (recipient: string) => boolean;
  readonly #leases: SupervisorEndpointLeaseReader;
  readonly #legacy: {
    delivery: SupervisorMessageV2DeliveryPort;
    readiness: SupervisorMessageV2DeliveryReadinessPort;
  };
  readonly #legacySeats: ReadonlySet<string>;

  constructor(input: {
    delivery: SupervisorMessageV2DeliveryPort;
    endpoint?: SupervisorEndpointDeliveryPort;
    enrollment?: SupervisorMessageV2RecipientEnrollmentPort;
    hasMailbox(recipient: string): boolean;
    leases: SupervisorEndpointLeaseReader;
    legacySeats: readonly string[];
    /** r8's readiness: the descriptor in the sender scope. */
    sessions: SupervisorMessageV2DeliveryReadinessPort;
  }) {
    this.#endpoint = input.endpoint;
    this.#enrollment = input.enrollment;
    this.#hasMailbox = input.hasMailbox;
    this.#leases = input.leases;
    this.#legacy = { delivery: input.delivery, readiness: input.sessions };
    this.#legacySeats = new Set(input.legacySeats);
  }

  /** The lease resolution, or undefined for an r8 seat with no lease row. */
  async #resolution(
    tenantId: string,
    recipient: string
  ): Promise<SupervisorEndpointLeaseResolution | undefined> {
    let resolution: SupervisorEndpointLeaseResolution;
    try {
      resolution = await this.#leases.resolve(tenantId, recipient);
    } catch {
      throw new SupervisorMessageV2ReadinessUnavailableError();
    }
    return this.#legacySeats.has(recipient) && resolution.state === "none"
      ? undefined
      : resolution;
  }

  async assertReady(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<unknown> {
    const resolution = await this.#resolution(trustedScope.tenantId, recipient);
    if (!resolution) {
      return this.#legacy.readiness.assertReady(trustedScope, recipient);
    }
    if (this.#endpoint) {
      return this.#endpoint.readiness.assertReady(trustedScope, recipient);
    }
    const route = decideSupervisorEndpointRoute(
      resolution,
      this.#hasMailbox(recipient)
    );
    if (route === "mailbox") {
      return { state: "mailbox-ready" };
    }
    if (route === "defer") {
      throw new Error(SUPERVISOR_ENDPOINT_REASONS.leaseExpired);
    }
    if (route === "none") {
      throw new Error(SUPERVISOR_ENDPOINT_REASONS.noEndpoint);
    }
    // A live lease with no adapter wired cannot be delivered to.
    throw new Error(SUPERVISOR_ENDPOINT_REASONS.probeFailed);
  }

  async deliver(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorMessageV2DeliveryOutcome> {
    let resolution: SupervisorEndpointLeaseResolution | undefined;
    try {
      resolution = await this.#resolution(envelope.tenantId, envelope.target);
    } catch {
      return {
        reason: "recipient endpoint store is unavailable",
        status: "transient-failure",
      };
    }
    if (!resolution) {
      return this.#legacy.delivery.deliver(envelope);
    }
    if (this.#endpoint) {
      return this.#endpoint.deliver(envelope);
    }
    const route = decideSupervisorEndpointRoute(
      resolution,
      this.#hasMailbox(envelope.target)
    );
    if (route === "mailbox") {
      return this.#legacy.delivery.deliver(envelope);
    }
    if (route === "endpoint") {
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
        status: "transient-failure",
      };
    }
    return supervisorEndpointUndeliverable(route);
  }

  notEnrolledSince(recipient: string): number | undefined {
    return (
      this.#enrollment?.notEnrolledSince(recipient) ??
      this.#endpoint?.readiness.notEnrolledSince(recipient)
    );
  }
}

/**
 * The one r9 route handler: sessions, each configured supervisor's gated SDK
 * ingress, and the sender's message status. Each supervisor's ingress shares
 * the primary's stores and trackers; only its SDK handler is used (the
 * primary ingress owns recovery).
 */
const createAllSupervisorsRoute = (input: {
  all: SupervisorA2AV2AllSupervisorsOptions;
  card: SupervisorA2AV2ServiceOptions["card"];
  leases(): LeaseResource | undefined;
  ledger: LedgerResource;
  log?: (line: string) => void;
  shared: Omit<
    SupervisorA2AV2IngressOptions,
    "card" | "operatorConfigPath" | "recoveryIntervalMs" | "supervisorId"
  >;
  statusCoordinator: SupervisorMessageV2Coordinator;
  taskStore: TaskStore;
  tenant: string;
}): NonNullable<SupervisorA2AV2Service["allSupervisorsRoute"]> => {
  const { all } = input;
  const gate = createA2AV2SupervisorIngressGate({
    authenticator: all.authenticator,
    mayReceive: all.mayReceive,
  });
  // The gate authenticated the request; the SDK adapter is handed that same
  // identity for exactly the request object the gate built.
  const gated = new WeakMap<Request, SupervisorA2AAuthenticatedIdentity>();
  const sdkAuthenticator: SupervisorA2AAuthenticator = {
    authenticate: (request) => gated.get(request),
  };
  const ingress = new Map<
    string,
    (
      request: Request,
      identity?: SupervisorA2AAuthenticatedIdentity
    ) => Promise<Response>
  >();
  const seats = new Map<string, SupervisorA2AV2Ingress>();
  const mount = (routeId: string, seatIngress: SupervisorA2AV2Ingress) => {
    const sdk = createSupervisorA2AHttpHandler({
      authenticator: sdkAuthenticator,
      handler: seatIngress.handler,
      pathname: a2aV2SupervisorIngressPath(all.routePath, routeId),
      tenant: input.tenant,
    });
    ingress.set(routeId, (request, identity) => {
      if (identity) {
        gated.set(request, identity);
      }
      return sdk(request);
    });
  };
  for (const supervisorId of new Set(all.supervisorIds)) {
    const pathname = a2aV2SupervisorIngressPath(all.routePath, supervisorId);
    const seatIngress = new SupervisorA2AV2Ingress({
      ...input.shared,
      card: {
        ...input.card,
        supervisorId,
        url: new URL(pathname, input.card.url).toString(),
      },
      ...(all.onAccepted ? { onAccepted: all.onAccepted } : {}),
      supervisorId,
    });
    seats.set(supervisorId, seatIngress);
    mount(supervisorId, seatIngress);
  }
  // RA2: a role id that aliases a configured legacy address is served by
  // that address's own ingress (same seat, same recipient); the gate below
  // decides the grant for the configured address, never the alias.
  const aliases = all.supervisorAliases ?? new Map<string, string>();
  for (const [alias, target] of aliases) {
    const seatIngress = seats.get(target);
    if (seatIngress && !seats.has(alias)) {
      mount(alias, seatIngress);
    }
  }
  const hub = all.inboxStream;
  const sessions = createA2AV2SessionRoutesHandler({
    authenticator: all.authenticator,
    leases: input.leases,
    ...(input.log ? { log: input.log } : {}),
    ...(hub
      ? {
          onLeaseChange: (recipient: string) =>
            hub.wake(input.tenant, recipient),
        }
      : {}),
    principalForRecipient: all.principalForRecipient,
    resolveLocator: all.resolveLocator,
    sessionTtlMs: all.sessionTtlMs,
    tenant: input.tenant,
  });
  const inbox = hub
    ? createSupervisorInboxStreamHandler({
        authenticator: all.authenticator,
        hub,
        leases: input.leases,
        ...(all.inboxStreamLimits ? { limits: all.inboxStreamLimits } : {}),
        principalForRecipient: all.principalForRecipient,
        tenant: input.tenant,
      })
    : undefined;
  const status = createA2AV2MessageStatusHandler({
    authenticator: all.authenticator,
    status: async (scope, workflowId) => {
      try {
        // Absent, or another tenant's or principal's: one answer, 404.
        await input.ledger.assertStartIntent(workflowId, scope);
      } catch (error) {
        if (error instanceof SupervisorMessageV2StartIntentScopeError) {
          return undefined;
        }
        // A ledger that cannot answer is 503 v2-unavailable (the contract),
        // never "no such message".
        throw error;
      }
      return input.statusCoordinator.status(scope, workflowId);
    },
    taskState: (scope, workflowId) =>
      a2aV2MessageTaskState(input.taskStore, scope, workflowId),
    tenant: input.tenant,
  });
  return {
    httpHandler: (request) => {
      const match = matchA2AV2Route(
        all.routePath,
        new URL(request.url).pathname
      );
      if (match?.route === "session") {
        return sessions(request, match.operation);
      }
      if (match?.route === "message-status") {
        return status(request, match.messageId);
      }
      if (match?.route === "session-inbox") {
        return inbox
          ? inbox(request, match.supervisorId)
          : Promise.resolve(routeError("v2-unavailable"));
      }
      const seat = match ? ingress.get(match.supervisorId) : undefined;
      return match && seat
        ? gate(
            request,
            seats.has(match.supervisorId)
              ? match.supervisorId
              : (aliases.get(match.supervisorId) ?? match.supervisorId),
            seat
          )
        : Promise.resolve(routeError("not-found"));
    },
    routePath: all.routePath,
  };
};

/** The primary route, unless r9 configured no r8 recipient to serve. */
const primaryRoutes = (
  options: SupervisorA2AV2ServiceOptions,
  handler: (request: Request) => Promise<Response>
): [string, (request: Request) => Promise<Response>][] =>
  options.route.mounted === false
    ? []
    : [[options.route.pathname ?? "/a2a", handler]];

/**
 * r9: open the lease store (T1) and build T2's endpoint port when wired, and
 * the routing every delivery path shares. Undefined without allSupervisors.
 * `onLeases` hands the store to the caller as soon as it is open, so a later
 * failure still closes it.
 */
const openAllSupervisorsRouting = async (input: {
  dependencies: SupervisorA2AV2ServiceDependencies;
  onInbox(inbox: InboxResource): void;
  onLeases(leases: LeaseResource): void;
  onStage(stage: string): void;
  options: SupervisorA2AV2ServiceOptions;
  sessions: SessionResource;
}): Promise<
  | {
      enrollment: Pick<
        SupervisorA2AV2SessionEnrollmentPort,
        "endpointLeases" | "endpointReadiness"
      >;
      routing: SupervisorA2AV2RecipientRouting;
    }
  | undefined
> => {
  const all = input.options.allSupervisors;
  if (!all) {
    return undefined;
  }
  let leases: LeaseResource | undefined;
  if (input.dependencies.connectLeases) {
    input.onStage("endpoint-lease-store");
    leases = await input.dependencies.connectLeases({
      databaseUrl: input.options.databaseUrl,
      now: input.options.now,
      resolveLocator: all.resolveLocator,
      sessions: input.sessions,
    });
    input.onLeases(leases);
    await leases.migrate?.();
  }
  // ra1: the inbox lives in the ledger's database, after the ledger's own
  // migration (its reads join the ledger's start intents).
  if (all.inboxStream && input.dependencies.connectInbox) {
    input.onStage("inbox-store");
    const inbox = await input.dependencies.connectInbox(
      input.options.databaseUrl
    );
    input.onInbox(inbox);
    await inbox.migrate?.();
    all.inboxStream.attach(inbox);
  }
  input.onStage("endpoint-delivery");
  const endpoint = all.endpointDelivery?.({
    leases: leases ?? NO_LEASES,
    sessions: input.sessions,
  });
  return {
    enrollment: {
      ...(leases ? { endpointLeases: leases } : {}),
      ...(endpoint ? { endpointReadiness: endpoint.readiness } : {}),
    },
    routing: new SupervisorA2AV2RecipientRouting({
      delivery: input.options.delivery,
      endpoint,
      enrollment: input.options.recipientEnrollment,
      hasMailbox: all.hasMailbox,
      leases: leases ?? NO_LEASES,
      legacySeats: all.legacySeats,
      sessions: input.sessions,
    }),
  };
};

/**
 * r9: the recipient route's lease rule, the result publication rule (the
 * same one), and the all-supervisors route. Empty without allSupervisors.
 */
const composeAllSupervisors = (input: {
  leases: LeaseResource | undefined;
  ledger: LedgerResource;
  options: SupervisorA2AV2ServiceOptions;
  sessions: SessionResource;
  shared: Parameters<typeof createAllSupervisorsRoute>[0]["shared"];
  statusCoordinator: SupervisorMessageV2Coordinator;
  taskStore: TaskStoreResource;
}): {
  endpoints?: SupervisorMessageV2RecipientEndpoints;
  reachable?(
    scope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<boolean>;
  route?: SupervisorA2AV2Service["allSupervisorsRoute"];
} => {
  const { options } = input;
  const all = options.allSupervisors;
  if (!all) {
    return {};
  }
  const endpoints: SupervisorMessageV2RecipientEndpoints = {
    hasMailbox: all.hasMailbox,
    leases: input.leases ?? NO_LEASES,
    legacySeats: new Set(all.legacySeats),
    ...(all.renewExpiredLease
      ? { renewExpiredLease: all.renewExpiredLease }
      : {}),
    resolveLocator: all.resolveLocator,
  };
  return {
    endpoints,
    reachable: createSupervisorMessageV2RecipientReachability({
      endpoints,
      principalForRecipient:
        options.recipientRoute?.principalForRecipient ??
        all.principalForRecipient,
      sessions: input.sessions,
      tenantId: options.route.tenant,
    }),
    route: createAllSupervisorsRoute({
      all,
      card: options.card,
      leases: () => input.leases,
      ledger: input.ledger,
      log: all.log ?? options.log,
      shared: input.shared,
      statusCoordinator: input.statusCoordinator,
      taskStore: input.taskStore,
      tenant: options.route.tenant,
    }),
  };
};

/**
 * Construct the standard local V2 composition from the maintained A2A SDK,
 * PostgreSQL stores, and Temporal workflow port. No listener is published by
 * this function, so construction alone cannot make V2 traffic live.
 */
export const createSupervisorA2AV2Service = async (
  options: SupervisorA2AV2ServiceOptions
): Promise<SupervisorA2AV2Service> => {
  const dependencies =
    options.dependencies ?? defaultSupervisorA2AV2ServiceDependencies;
  // One tracker for every delivery path of this service, so a recipient's
  // outage is logged, bounded, and counted once, whichever path delivers.
  const readinessOutage = new SupervisorMessageV2ReadinessOutageTracker({
    boundMs: options.readinessOutageBoundMs,
  });
  // r9: lease-aware delivery and readiness for every configured supervisor,
  // built once the stores are open. Its not-enrolled port adds T2's expired
  // leases to the host's own enrollment.
  let routing: SupervisorA2AV2RecipientRouting | undefined;
  // Likewise one not-enrolled deferral for every path, fed by the host's
  // own enrollment of its seats.
  const notEnrolled = new SupervisorMessageV2NotEnrolledDeferral({
    boundMs: options.notEnrolledBoundMs,
    enrollment: {
      notEnrolledSince: (recipient) =>
        (routing ?? options.recipientEnrollment)?.notEnrolledSince(recipient),
    },
  });
  let taskStore: TaskStoreResource | undefined;
  let ledger: LedgerResource | undefined;
  let sessions: SessionResource | undefined;
  let leases: LeaseResource | undefined;
  let inbox: InboxResource | undefined;
  let ingress: SupervisorA2AV2Ingress | undefined;
  let host: TemporalSupervisorRuntimeHost | undefined;
  let receipts: PostgresSupervisorMessageV2GovernanceReceiptStore | undefined;
  let stage = "task-store";
  try {
    taskStore = await dependencies.connectTaskStore({
      databaseUrl: options.databaseUrl,
    });
    await taskStore.migrate();
    stage = "delivery-ledger";
    // Workflow ids are minted for this host's deployment: the task queue its
    // worker polls and its workflow port starts and adopts executions on.
    // The ledger records this build with any id format it sets.
    ledger = await dependencies.connectLedger(options.databaseUrl, {
      buildId: options.host.buildId,
      deployment: options.host.taskQueue,
      resultGraphKey: options.resultGraphKey,
      previousResultGraphKeys: options.previousResultGraphKeys,
      ...(options.workflowIdFormat
        ? { workflowIdFormat: options.workflowIdFormat }
        : {}),
    });
    await ledger.migrate();
    reportWorkflowIdFormat(ledger, options.log);
    await reportUnpublishableResultBindings(
      ledger,
      options,
      settledResultBinding(taskStore),
      options.log
    );
    await reportUnboundPreviousKeyResultGraphs(ledger, options, options.log);
    stage = "session-store";
    sessions = await dependencies.connectSessions({
      authority: options.rebindAuthority,
      databaseUrl: options.databaseUrl,
      now: options.now,
      provider: options.providerReadiness,
    });
    await sessions.migrate();
    const opened = await openAllSupervisorsRouting({
      dependencies,
      onInbox: (store) => {
        inbox = store;
      },
      onLeases: (store) => {
        leases = store;
      },
      onStage: (next) => {
        stage = next;
      },
      options,
      sessions,
    });
    routing = opened?.routing;
    const delivery: SupervisorMessageV2DeliveryPort =
      routing ?? options.delivery;
    const readiness: SupervisorMessageV2DeliveryReadinessPort =
      routing ?? sessions;
    if (options.enrollSessions) {
      stage = "session-enrollment";
      const store = sessions;
      await options.enrollSessions({
        currentSession: (scope, recipient) => store.current(scope, recipient),
        ...opened?.enrollment,
        rebindSession: (scope, descriptor) => store.rebind(scope, descriptor),
        registerSession: (scope, descriptor) =>
          store.register(scope, descriptor),
      });
    }
    const workflows = dependencies.createWorkflows(
      options.host.workflowClient,
      options.host.taskQueue
    );
    let governance: GovernedSupervisorMessageV2Service | undefined;
    if (options.messageAuthority) {
      stage = "governance-store";
      receipts =
        await PostgresSupervisorMessageV2GovernanceReceiptStore.connect(
          options.databaseUrl
        );
      await receipts.migrate();
      governance = new GovernedSupervisorMessageV2Service({
        authority: options.messageAuthority,
        coordinator: new SupervisorMessageV2Coordinator(
          workflows,
          delivery,
          ledger,
          options.dispatchOwner,
          () => new Date(options.now()),
          readiness,
          readinessOutage,
          notEnrolled
        ),
        now: options.now,
        receipts,
      });
    }
    // Every ingress (primary and peer) shares these, the outage tracker and
    // the not-enrolled deferral among them.
    const shared = {
      delivery,
      dispatchOwner: options.dispatchOwner,
      ledger,
      notEnrolled,
      now: options.now,
      policy: options.policy,
      readinessOutage,
      sessionReadiness: readiness,
      taskStore,
      workflows,
    };
    ingress = new SupervisorA2AV2Ingress({
      ...shared,
      card: options.card,
      operatorConfigPath: options.operatorConfigPath,
      recoveryIntervalMs: options.recoveryIntervalMs,
      supervisorId: options.supervisorId,
    });
    const gates = new SupervisorSessionV2DagAdapter(sessions);
    stage = "runtime-host";
    host = await dependencies.createHost({
      ...options.host,
      v2Ingress: ingress,
      v2SessionGates: gates,
      workflowPort: workflows,
    });
    stage = "http-routes";
    const primaryHandler = createSupervisorA2AHttpHandler({
      authenticator: options.route.authenticator,
      handler: ingress.handler,
      pathname: options.route.pathname,
      tenant: options.route.tenant,
    });
    const routes = new Map(primaryRoutes(options, primaryHandler));
    for (const peer of options.peerRoutes ?? []) {
      validatePeerRoute(peer, [
        ...routes.keys(),
        "/healthz",
        options.recipientRoute?.pathname,
        options.assignmentRoute?.pathname,
        options.resultGraphRoute?.pathname,
      ]);
      const peerIngress = new SupervisorA2AV2Ingress({
        ...shared,
        card: {
          ...options.card,
          supervisorId: peer.supervisorId,
          url: new URL(peer.pathname, options.card.url).toString(),
        },
        supervisorId: peer.supervisorId,
      });
      // Only its SDK handler is used. The primary ingress owns the sole
      // recovery lifecycle for the shared ledger and Temporal worker.
      routes.set(
        peer.pathname,
        createSupervisorA2AHttpHandler({
          authenticator: options.route.authenticator,
          handler: peerIngress.handler,
          pathname: peer.pathname,
          tenant: options.route.tenant,
        })
      );
    }
    const httpHandler = (request: Request): Promise<Response> => {
      const handler = routes.get(new URL(request.url).pathname);
      return handler
        ? handler(request)
        : Promise.resolve(new Response(null, { status: 404 }));
    };
    const r9 = composeAllSupervisors({
      leases,
      ledger,
      options,
      sessions,
      shared,
      statusCoordinator: new SupervisorMessageV2Coordinator(
        workflows,
        delivery,
        ledger,
        options.dispatchOwner,
        () => new Date(options.now()),
        readiness,
        readinessOutage,
        notEnrolled
      ),
      taskStore,
    });
    let recipientRoute: SupervisorA2AV2Service["recipientRoute"];
    let ownedService: OwnedSupervisorA2AV2Service;
    const assignmentRoute = createAssignmentRoute(
      options,
      ledger,
      (scope, binding) => ownedService.bindResult(scope, binding),
      readinessOutage,
      settledResultBinding(taskStore)
    );
    const resultGraphRoute = createResultGraphRoute(options, (scope, command) =>
      ownedService.startResultGraph(scope, command)
    );
    if (options.recipientRoute) {
      if (
        !(governance && ledger.recipientAssignment) ||
        options.recipientRoute.pathname === (options.route.pathname ?? "/a2a")
      ) {
        throw new Error(
          "Recipient route requires governed durable assignments and a distinct path"
        );
      }
      const resolveAssignment =
        createSupervisorMessageV2RecipientAssignmentResolver({
          tenantId: options.route.tenant,
          principalForRecipient: options.recipientRoute.principalForRecipient,
          ledger: {
            recipientAssignment: ledger.recipientAssignment.bind(ledger),
          },
          sessions,
          endpoints: r9.endpoints,
        });
      recipientRoute = {
        pathname: options.recipientRoute.pathname,
        httpHandler: createSupervisorMessageV2RecipientHttpHandler({
          ...options.recipientRoute,
          governance,
          resolveAssignment,
          publishResult: (scope, command) =>
            ownedService.publishResult(scope, command),
        }),
        lifecycle: (identity, command) =>
          runSupervisorMessageV2RecipientLifecycle(
            { governance, resolveAssignment },
            identity,
            command
          ),
      };
    }
    const inboxHub = options.allSupervisors?.inboxStream;
    const openedInbox = inbox;
    ownedService = new OwnedSupervisorA2AV2Service({
      allSupervisorsRoute: r9.route,
      assignmentRoute,
      ...(openedInbox
        ? {
            inbox: {
              close: () => {
                inboxHub?.detach();
                return openedInbox.close();
              },
            },
          }
        : {}),
      leases,
      reachable: r9.reachable,
      workflows,
      now: options.now,
      previousResultGraphKeys: options.previousResultGraphKeys,
      resultGraphKey: options.resultGraphKey,
      resultGraphRoute,
      resultGraphTasks: options.resultGraphTasks,
      verifyResultArtifact: options.verifyResultArtifact,
      recipientRoute,
      governance,
      receipts,
      host,
      httpHandler,
      ledger,
      pathname: options.route.pathname ?? "/a2a",
      pathnames: [...routes.keys()],
      notEnrolled,
      readinessOutage,
      sessions,
      taskStore,
    });
    return ownedService;
  } catch (error) {
    // Keep connection information out of application errors and logs. The
    // caller gets a stable failure while each acquired resource is released in
    // reverse dependency order.
    await closeQuietly(host ?? ingress);
    await closeQuietly(receipts);
    options.allSupervisors?.inboxStream?.detach();
    await closeQuietly(inbox);
    await closeQuietly(leases);
    await closeQuietly(sessions);
    await closeQuietly(ledger);
    await closeQuietly(taskStore);
    // A refusal over the ledger's workflow id format is the operator's to
    // act on, and its message names formats, builds and counts only.
    if (error instanceof SupervisorMessageV2WorkflowIdFormatError) {
      throw new Error(
        `Supervisor A2A V2 service initialization failed at ${stage}: ${error.message}`
      );
    }
    const category = safeFailureCategory(error);
    throw new Error(
      `Supervisor A2A V2 service initialization failed at ${stage} (${category})`
    );
  }
};

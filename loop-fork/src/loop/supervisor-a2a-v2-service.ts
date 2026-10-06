import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import {
  PostgresA2ATaskStore,
  type PostgresA2ATaskStoreOptions,
} from "./a2a-postgres-task-store";
import {
  createSupervisorA2AAssignmentHttpHandler,
  createSupervisorA2AResultGraphStartHttpHandler,
} from "./a2a-supervisor-assignment-http";
import { WORKFLOW_IDS_METADATA_KEY } from "./a2a-supervisor-executor";
import {
  createSupervisorA2AHttpHandler,
  type SupervisorA2AAuthenticator,
} from "./a2a-supervisor-http";
import {
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
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  type SupervisorResultGraphKey,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  PostgresSupervisorMessageV2DeliveryLedger,
  type PostgresSupervisorMessageV2DeliveryLedgerOptions,
} from "./supervisor-message-v2-delivery-ledger";
import {
  GovernedSupervisorMessageV2Service,
  PostgresSupervisorMessageV2GovernanceReceiptStore,
  type SupervisorMessageV2AuthorityPort,
} from "./supervisor-message-v2-governance";
import { createSupervisorMessageV2RecipientHttpHandler } from "./supervisor-message-v2-http";
import { createSupervisorMessageV2RecipientAssignmentResolver } from "./supervisor-message-v2-recipient-assignment";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  type SupervisorMessageV2DeliveryPort,
  type SupervisorMessageV2ReadinessOutageSnapshot,
  SupervisorMessageV2ReadinessOutageTracker,
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

const PEER_SUPERVISOR_ID = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
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
  close(): Promise<void>;
  migrate(): Promise<void>;
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

const defaultDependencies: SupervisorA2AV2ServiceDependencies = {
  connectLedger: (databaseUrl, options) =>
    PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl, options),
  connectSessions: (input) => PostgresSupervisorSessionV2Store.connect(input),
  connectTaskStore: (options) => PostgresA2ATaskStore.connect(options),
  createHost: (options) => TemporalSupervisorRuntimeHost.create(options),
  createWorkflows: (client, taskQueue) =>
    new TemporalWorkflowPort(client, { taskQueue }),
};

export interface SupervisorA2AV2ServiceOptions {
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
  now: () => string;
  /** The host's config file, named in the recovery quarantine commands an
   * operator is told to run. */
  operatorConfigPath?: string;
  peerRoutes?: readonly { pathname: string; supervisorId: string }[];
  policy: SupervisorA2AV2IngressOptions["policy"];
  providerReadiness: SupervisorSessionProviderReadinessPort;
  /**
   * How long a session readiness-store outage may defer a recipient's
   * deliveries before each one fails as a normal retryable attempt. Omitted,
   * SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS.
   */
  readinessOutageBoundMs?: number;
  rebindAuthority: SupervisorSessionRebindAuthorityPort;
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
    pathname?: string;
    tenant: string;
  };
  supervisorId: string;
  /** True only when `reference` is verified evidence for exactly `target`. */
  verifyResultArtifact?(
    reference: string,
    target: SupervisorA2AResultArtifactTarget
  ): Promise<boolean>;
}

/** The governed session-store operations available to start-time enrollment. */
export type SupervisorA2AV2SessionEnrollmentPort = Pick<
  SupervisorA2AV2Service,
  "currentSession" | "rebindSession" | "registerSession"
>;

export interface SupervisorA2AV2Service {
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
  readonly assignmentRoute: SupervisorA2AV2Service["assignmentRoute"];
  readonly #workflows: WorkflowPort;
  readonly #now: () => string;
  readonly #resultGraphKey: SupervisorResultGraphKey | undefined;
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
  readonly #readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
  readonly #sessions: SessionResource;
  readonly #taskStore: TaskStoreResource;
  #closing: Promise<void> | undefined;

  constructor(input: {
    assignmentRoute?: SupervisorA2AV2Service["assignmentRoute"];
    workflows: WorkflowPort;
    now: () => string;
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
    readinessOutage: SupervisorMessageV2ReadinessOutageTracker;
    sessions: SessionResource;
    taskStore: TaskStoreResource;
  }) {
    this.assignmentRoute = input.assignmentRoute;
    this.#workflows = input.workflows;
    this.#now = input.now;
    this.#resultGraphKey = input.resultGraphKey;
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
    this.#readinessOutage = input.readinessOutage;
    this.#sessions = input.sessions;
    this.#taskStore = input.taskStore;
  }

  readinessOutage(): SupervisorMessageV2ReadinessOutageSnapshot {
    return this.#readinessOutage.snapshot(new Date(this.#now()));
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
    await this.#sessions.assertReady(scope, input.recipient);
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

/**
 * Recorded bindings that will never publish (a graph the request body chose
 * before graphs were derived, or an unreadable row), reported at every start,
 * one line each with ids only, until each message is re-bound.
 */
const reportUnpublishableResultBindings = async (
  ledger: LedgerResource,
  log: (line: string) => void = (line) => console.error(line)
): Promise<void> => {
  for (const entry of (await ledger.unpublishableResultBindings?.()) ?? []) {
    log(
      `A2A V2 result binding will never publish (${entry.reason}): tenant ${entry.tenantId} message ${entry.messageWorkflowId} A2A task ${entry.a2aTaskId}; re-bind it to its message-derived result graph`
    );
  }
};

const createAssignmentRoute = (
  options: SupervisorA2AV2ServiceOptions,
  ledger: LedgerResource,
  bind: SupervisorA2AV2Service["bindResult"]
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
  return {
    pathname: options.assignmentRoute.pathname,
    httpHandler: createSupervisorA2AAssignmentHttpHandler({
      ...options.assignmentRoute,
      authenticator: options.route.authenticator,
      tenant: options.route.tenant,
      bind,
      // The inspection surface lists only this route's tenant. Quarantined
      // recovery records are reported here, never on /healthz.
      recoveryQuarantine: quarantined
        ? (scope) => quarantined(scope.tenantId)
        : undefined,
      unpublishable: list ? (scope) => list(scope.tenantId) : undefined,
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

/**
 * Construct the standard local V2 composition from the maintained A2A SDK,
 * PostgreSQL stores, and Temporal workflow port. No listener is published by
 * this function, so construction alone cannot make V2 traffic live.
 */
export const createSupervisorA2AV2Service = async (
  options: SupervisorA2AV2ServiceOptions
): Promise<SupervisorA2AV2Service> => {
  const dependencies = options.dependencies ?? defaultDependencies;
  // One tracker for every delivery path of this service, so a recipient's
  // outage is logged, bounded, and counted once, whichever path delivers.
  const readinessOutage = new SupervisorMessageV2ReadinessOutageTracker({
    boundMs: options.readinessOutageBoundMs,
  });
  let taskStore: TaskStoreResource | undefined;
  let ledger: LedgerResource | undefined;
  let sessions: SessionResource | undefined;
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
    ledger = await dependencies.connectLedger(options.databaseUrl, {
      deployment: options.host.taskQueue,
      resultGraphKey: options.resultGraphKey,
    });
    await ledger.migrate();
    await reportUnpublishableResultBindings(ledger, options.log);
    stage = "session-store";
    sessions = await dependencies.connectSessions({
      authority: options.rebindAuthority,
      databaseUrl: options.databaseUrl,
      now: options.now,
      provider: options.providerReadiness,
    });
    await sessions.migrate();
    if (options.enrollSessions) {
      stage = "session-enrollment";
      const store = sessions;
      await options.enrollSessions({
        currentSession: (scope, recipient) => store.current(scope, recipient),
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
          options.delivery,
          ledger,
          options.dispatchOwner,
          () => new Date(options.now()),
          sessions,
          readinessOutage
        ),
        now: options.now,
        receipts,
      });
    }
    // Every ingress (primary and peer) shares these, the outage tracker
    // among them.
    const shared = {
      delivery: options.delivery,
      dispatchOwner: options.dispatchOwner,
      ledger,
      now: options.now,
      policy: options.policy,
      readinessOutage,
      sessionReadiness: sessions,
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
    const routes = new Map([
      [options.route.pathname ?? "/a2a", primaryHandler],
    ]);
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
    let recipientRoute: SupervisorA2AV2Service["recipientRoute"];
    let ownedService: OwnedSupervisorA2AV2Service;
    const assignmentRoute = createAssignmentRoute(
      options,
      ledger,
      (scope, binding) => ownedService.bindResult(scope, binding)
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
      };
    }
    ownedService = new OwnedSupervisorA2AV2Service({
      assignmentRoute,
      workflows,
      now: options.now,
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
    await closeQuietly(sessions);
    await closeQuietly(ledger);
    await closeQuietly(taskStore);
    const category = safeFailureCategory(error);
    throw new Error(
      `Supervisor A2A V2 service initialization failed at ${stage} (${category})`
    );
  }
};

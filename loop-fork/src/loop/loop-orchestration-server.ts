import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { serve } from "bun";
import {
  type A2AV2EnvFileRefusal,
  type A2AV2EnvFileRefusalCode,
  a2aV2EnvFilePath,
  loadA2AV2EnvFile,
  probeA2AV2Database,
  withA2AV2EnvFile,
} from "./a2a-v2-env";
import { matchA2AV2Route } from "./a2a-v2-routes-contract";
import { a2aV2TimingProbe } from "./a2a-v2-timing";
import { readBridgeStatus } from "./bridge-store";
import {
  BridgeSupervisorMessageDeliveryPort,
  type SupervisorBridgeDirectory,
} from "./bridge-supervisor-message-delivery";
import {
  createGitResultArtifactVerifier,
  type GitResultArtifactBinding,
} from "./git-result-artifact";
import { GOVERNESS_BEAT_WORKFLOW_TYPE } from "./governess-beat-workflow";
import { HeadlessClaudeWakePort } from "./headless-claude-wake-port";
import { spawnHeadless } from "./headless-runner";
import { LoopSupervisorDirectory } from "./loop-supervisor-directory";
import { isActiveRunState, readRunManifest } from "./run-state";
import {
  createSupervisorA2AV2Service,
  defaultSupervisorA2AV2ServiceDependencies,
  type SupervisorA2AV2Service,
  type SupervisorA2AV2ServiceDependencies,
} from "./supervisor-a2a-v2-service";
import { SupervisorBridgeConsumptionReconciler } from "./supervisor-bridge-consumption";
import { SupervisorDeadlineDriver } from "./supervisor-deadline-driver";
import {
  createSupervisorEndpointLocatorResolver,
  SUPERVISOR_ENDPOINT_KINDS,
  SUPERVISOR_ENDPOINT_MANIFEST_FILE,
  type SupervisorEndpointFs,
  type SupervisorEndpointLeaseReader,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocatorResolver,
  type SupervisorEndpointRoots,
  supervisorEndpointLeaseState,
  supervisorEndpointRef,
  supervisorEndpointRoots,
} from "./supervisor-endpoint-lease";
import { SupervisorMailboxConsumptionReconciler } from "./supervisor-mailbox-consumption";
import {
  FirstAvailableDeliveryPort,
  MailboxSupervisorMessageDeliveryPort,
} from "./supervisor-mailbox-delivery";
import {
  JsonlSupervisorMessageReceiptPort,
  type SupervisorMessageAuthorityPort,
  type SupervisorMessageGovernedOperation,
} from "./supervisor-message-governance";
import { SupervisorMessageV2BridgeDeliveryPort } from "./supervisor-message-v2-bridge-delivery";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  SUPERVISOR_MESSAGE_V2_LEGACY_RESULT_GRAPH_WORKFLOW_ID_RE,
  SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE,
  SupervisorResultGraphKey,
} from "./supervisor-message-v2-contract";
import {
  PostgresSupervisorMessageV2DeliveryLedger,
  SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS,
  type SupervisorMessageV2RecoveryQuarantineEntry,
  type SupervisorMessageV2WorkflowIdFormat,
  SupervisorMessageV2WorkflowIdFormatError,
} from "./supervisor-message-v2-delivery-ledger";
import {
  SUPERVISOR_ENDPOINT_REASONS,
  type SupervisorEndpointDeliveryPort,
  type SupervisorEndpointKindAdapters,
} from "./supervisor-message-v2-endpoint-contract";
import {
  checkSupervisorEndpointLease,
  createSupervisorEndpointKindAdapters,
  createSupervisorEndpointMailboxPort,
  SupervisorEndpointDescriptorReadiness,
  SupervisorEndpointMessageV2Delivery,
} from "./supervisor-message-v2-endpoint-delivery";
import { SUPERVISOR_MESSAGE_WORKFLOW_TYPE } from "./supervisor-message-workflow";
import type {
  SupervisorControlSurfaceAuthenticator,
  SupervisorControlSurfaceIdentity,
} from "./supervisor-orchestration-http";
import {
  deriveSupervisorSessionDescriptorV2Id,
  type SupervisorSessionDescriptorV2,
} from "./supervisor-session-v2";
import { LoopCodexSessionV2ProviderReadiness } from "./supervisor-session-v2-codex-readiness";
import { JsonlSupervisorThreadStore } from "./supervisor-thread-store";
import { SupervisorWakeDriver } from "./supervisor-wake-driver";
import { TASK_GRAPH_WORKFLOW_TYPE } from "./task-graph-workflow";
import { TemporalSupervisorRuntimeHost } from "./temporal-supervisor-runtime";
import { temporalWorkflowBundleBase64 } from "./temporal-workflow-bundle.generated";

/**
 * The workflow types this orchestration server hosts. Registration happens
 * through the shared workflow bundle (temporal-workflow.ts dispatches on type),
 * so this list is the declared surface of that bundle rather than a second
 * registry. gov-6 adds the governess beat: one workflow per run, keyed
 * `governess-beat:v2:<repoId>:<runId>:<taskQueue>` since fix7 (before it,
 * `governess-beat:<runId>`), whose history is the governess journal.
 */
export const LOOP_ORCHESTRATION_WORKFLOW_TYPES = [
  GOVERNESS_BEAT_WORKFLOW_TYPE,
  SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
  TASK_GRAPH_WORKFLOW_TYPE,
] as const;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const HOST_RE = /^(?:127\.0\.0\.1|::1|localhost)$/;
const SUPERVISOR_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const OPERATIONS = new Set<SupervisorMessageGovernedOperation>([
  "acknowledge",
  "cancel",
  "claim",
  "receive",
  "tick",
]);
const ABSOLUTE_PATH_RE = /^\/[^\0]{1,4095}$/;
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
// A session name as ListAgents prints it: spaces and punctuation are ordinary
// there, so this bounds length and excludes control characters rather than
// imposing a shape the app does not use.
const SESSION_NAME_RE = /^[^\p{Cc}]{1,128}$/u;
const TEMPORAL_ADDRESS_RE = /^[a-zA-Z0-9.:[\]-]{1,255}$/;
const ENDPOINT_REF_RE = /^endpoint:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const V2_PRINCIPAL_RE = /^principal:[a-z0-9][a-z0-9._:-]{0,255}$/;
const ROUTE_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/;
const V2_TENANT_RE = /^tenant:[a-z0-9][a-z0-9._-]{0,127}$/;
// A V2 dispatch owner and authority reference allow [A-Za-z0-9._:-] only.
const V2_REFERENCE_INVALID_RE = /[^A-Za-z0-9._:-]/g;
const SEAT_RE = /^(claude|codex)$/;

interface SupervisorConfig {
  // Absolute mailbox file for a supervisor with no Loop pane. Delivery to it is
  // POLLING-ONLY: the session reads the file on its own schedule.
  mailbox?: string;
  manifestPath?: string;
  principal: string;
  seat?: "claude" | "codex";
  supervisorId: string;
  tokenEnv: string;
  /**
   * The addressable session name, exactly as `ListAgents` prints it, for a
   * recipient that can be woken. Absent means this recipient has no supported
   * wake on this host — for example a Codex task, which is woken by its own
   * channel. Such a recipient is reported as unsupported and NEVER matched by a
   * guessed name.
   */
  wakeSession?: string;
}

interface WakeConfig {
  intervalMs: number;
}

export interface A2AV2Config {
  databaseUrlEnv: string;
  endpointRef: string;
  /**
   * How long a recipient that is not enrolled (its seat stopped or
   * unreachable) may defer its V2 deliveries without spending attempts
   * (1000..86400000 ms), measured from when enrollment first failed, before
   * each delivery fails as a normal retryable attempt. Omitted, the runtime
   * default of 15 minutes.
   */
  notEnrolledBoundMs?: number;
  policy: {
    claimTimeoutMs: number;
    escalationTimeoutMs: number;
    maxDeliveryAttempts: number;
    retryDelayMs: number;
  };
  /**
   * Names of the environment variables holding the keys this host used
   * before `resultGraphKeyEnv` (a rotation). Bindings derived under them
   * still publish; nothing new is derived or bound under them, so bind every
   * result graph started under a key before it becomes a previous key (one
   * left unbound is reported at start and must be started again under the
   * primary key). Never the secrets. Requires `resultGraphKeyEnv`.
   */
  previousResultGraphKeyEnvs?: string[];
  principal: string;
  /**
   * How long a session readiness-store outage may defer a recipient's V2
   * deliveries (1000..86400000 ms) before each delivery fails as a normal
   * retryable attempt. Omitted, the runtime default of 15 minutes.
   */
  readinessOutageBoundMs?: number;
  /**
   * r8's single manifest-bound recipient (its bare route, /seats/ peers and
   * enrollment). r9: optional. With or without it, every configured
   * supervisor is a recipient through its own ingress and session lease.
   */
  recipient?: string;
  resultArtifacts?: GitResultArtifactBinding[];
  /**
   * Name of the environment variable holding the host secret that keys
   * result graph ids (HMAC-SHA256, at least 32 bytes). Never the secret
   * itself. Required when `resultArtifacts` has entries.
   */
  resultGraphKeyEnv?: string;
  routePath: string;
  sessionTtlMs: number;
  tenant: string;
  /**
   * The V2 workflow id format new messages are written in: "legacy" (the id
   * a pre-discriminator build reads, so that build's workflow-id path still
   * works after a rollback) or "deployment" (scoped to this host's task
   * queue). Legacy ids carry no deployment discriminator, so hosts on
   * different task queues that share the ledger database are not isolated
   * from each other until all of them write "deployment". Omitted, the
   * format the ledger database records, or "legacy" when it records none.
   * "deployment" is an explicit opt-in; returning to "legacy" is refused
   * while any deployment-format message is unsettled.
   */
  workflowIdFormat?: SupervisorMessageV2WorkflowIdFormat;
}

interface DeadlineConfig {
  // No principal: `tick` is granted per message pair, to the recipient's
  // principal, so the driver derives it from the grants of record rather than
  // running the whole estate under one identity.
  intervalMs: number;
}

interface GrantConfig {
  from: string;
  operations: SupervisorMessageGovernedOperation[];
  principal: string;
  to: string;
}

interface ServerConfig {
  a2aV2?: A2AV2Config;
  address: string;
  buildId: string;
  // Owner of message retry and escalation deadlines. Without it, a delivery
  // that fails transiently waits for some client to tick it, which is how three
  // messages sat undelivered from 2026-09-06 to 2026-09-19.
  deadlines?: DeadlineConfig;
  grants: GrantConfig[];
  hostname: string;
  identity: string;
  namespace: string;
  port: number;
  stateDir: string;
  supervisors: SupervisorConfig[];
  taskQueue: string;
  // Absent means no waking at all: the service behaves exactly as before.
  wake?: WakeConfig;
}

/**
 * Programmatic composition only. The config parser remains strict V1 until a
 * real provider-session and secret-delivery contract is accepted. A caller
 * that has constructed the standard V2 service can mount its authenticated
 * route without starting a second Temporal host or publishing a second Bun
 * listener.
 */
/**
 * r9: the endpoint lease store (T1) and the per-kind endpoint delivery (T2)
 * the server composes. Each is optional: without a lease store the session
 * routes answer 503 `v2-unavailable`; without endpoint delivery a
 * lease-backed recipient is unready while mailbox-held ones are delivered.
 */
export interface A2AV2EndpointFactories {
  /**
   * The per-kind adapters (probe and delivery) every endpoint path of one
   * server shares: delivery, the provider readiness of a lease-backed
   * descriptor, and the lease sweep's observation. Default: the bridge's own
   * effects (createSupervisorEndpointKindAdapters()).
   */
  adapters?(): SupervisorEndpointKindAdapters;
  connectLeases?: SupervisorA2AV2ServiceDependencies["connectLeases"];
  endpointDelivery?(input: {
    adapters: SupervisorEndpointKindAdapters;
    leases: SupervisorEndpointLeaseReader;
    mailboxes: ReadonlyMap<string, string>;
    principalForRecipient(recipient: string): string | undefined;
    /** The server's own resolver: every probe and delivery re-resolves. */
    resolveLocator: SupervisorEndpointLocatorResolver;
    sessions: {
      current(
        scope: { principal: string; tenantId: string },
        recipient: string
      ): Promise<SupervisorSessionDescriptorV2 | undefined>;
    };
  }): SupervisorEndpointDeliveryPort;
}

/**
 * The factories a production server uses: T1's PostgreSQL lease store over
 * the service's own session store (same connection, descriptor table and
 * rebind authority), and T2's per-kind endpoint delivery with the V1 mailbox
 * writer behind the V2 envelope. Mailbox wake stays the existing wake sweep's.
 */
export const defaultA2AV2EndpointFactories: A2AV2EndpointFactories = {
  connectLeases: ({ resolveLocator, sessions }) => {
    if (typeof sessions.endpointLeases !== "function") {
      return Promise.reject(
        new Error("session store has no endpoint lease store")
      );
    }
    const store = sessions.endpointLeases({ resolveLocator });
    return Promise.resolve({
      ...store,
      // The session store owns the connection and created the table in its
      // own migrate; the service closes it.
      close: () => Promise.resolve(),
    });
  },
  endpointDelivery: (input) => {
    const mailboxes = {
      resolveMailbox: (recipient: string) => input.mailboxes.get(recipient),
    };
    return new SupervisorEndpointMessageV2Delivery({
      adapters: input.adapters,
      leases: input.leases,
      mailbox: createSupervisorEndpointMailboxPort(mailboxes),
      mailboxes,
      now: () => new Date(),
      principalForRecipient: input.principalForRecipient,
      resolveLocator: input.resolveLocator,
      sessions: input.sessions,
    });
  },
};

export interface LoopOrchestrationServerOptions {
  /** Test seam: the server's own endpoint roots (default: its home's). */
  a2aV2EndpointRoots?: SupervisorEndpointRoots;
  /** r9: replaces `defaultA2AV2EndpointFactories` (a test seam). */
  a2aV2Endpoints?: A2AV2EndpointFactories;
  a2aV2Service?: SupervisorA2AV2Service;
  /** Test seam: the start-time ledger database probe (decideA2AV2Plane). */
  probeA2AV2Database?: (databaseUrl: string) => Promise<boolean>;
  /**
   * Stops the server as SIGINT or SIGTERM would, for an embedding caller or a
   * test driving the whole composition. The signals still stop it.
   */
  signal?: AbortSignal;
}

export interface LoopOrchestrationFetchHandlerOptions {
  /**
   * r9: the configured a2aV2.routePath while V2 is configured but not
   * mounted (disabled by a fault): its routes answer 503 `v2-unavailable`
   * instead of reaching V1. V1 is unaffected.
   */
  a2aV2DisabledRoutePath?: () => string | undefined;
  a2aV2Service?: Pick<
    SupervisorA2AV2Service,
    | "allSupervisorsRoute"
    | "httpHandler"
    | "notEnrolledDeferral"
    | "pathname"
    | "pathnames"
    | "readinessOutage"
    | "recipientRoute"
    | "assignmentRoute"
    | "resultGraphRoute"
  >;
  /**
   * fix8: whether the A2A V2 plane is mounted ("ready"), not configured
   * ("off": the config has no a2aV2 section) or configured but disabled at
   * start ("disabled", with a reason code: see `A2AV2DisabledReason`).
   * /healthz reports it as `a2aV2` and, when disabled, `a2aV2Reason`; it does
   * not change `state`, which V1 owns. The server always supplies it; the
   * fields are left out only when it is not.
   */
  a2aV2State?: () => A2AV2PlaneStatus;
  authenticator: SupervisorControlSurfaceAuthenticator;
  host: Pick<TemporalSupervisorRuntimeHost, "httpHandler" | "workerState">;
  /**
   * The configured A2A V2 seats that are not enrolled now (a peer degraded
   * at start, or any seat whose enrollment failed since). /healthz reports
   * only how many, as `notEnrolledCount`; the seat ids are on the
   * authenticated assignment status (GET on the assignment route). It does
   * not change `state`, which stays about the server itself. The server
   * always supplies it (an empty list when it enrolls no A2A V2 seats); the
   * field is left out only when it is not.
   */
  notEnrolledSeats?: () => readonly string[];
  reconciliationHealthy: () => boolean;
}

const planeHealth = (
  status: A2AV2PlaneStatus
): { a2aV2: A2AV2PlaneState; a2aV2Reason?: A2AV2DisabledReason } => ({
  a2aV2: status.state,
  ...(status.reason ? { a2aV2Reason: status.reason } : {}),
});

/**
 * The unauthenticated GET /healthz body. Counts and aggregate state only:
 * no seat, recipient, session, or store detail reaches this route. Which
 * seats are not enrolled, and which recipients a readiness outage defers,
 * are on the authenticated assignment status.
 */
const orchestrationHealth = (
  options: LoopOrchestrationFetchHandlerOptions
): Response =>
  Response.json({
    ...(options.a2aV2State ? planeHealth(options.a2aV2State()) : {}),
    ...(options.notEnrolledSeats
      ? { notEnrolledCount: options.notEnrolledSeats().length }
      : {}),
    schema: "loop-orchestration-health.v1",
    state:
      options.host.workerState() === "RUNNING" &&
      options.reconciliationHealthy()
        ? "ready"
        : "unavailable",
    // Additive deferral counters. A readiness-store outage or a recipient
    // that is not enrolled defers deliveries without changing `state`.
    ...(options.a2aV2Service
      ? {
          a2aV2NotEnrolledDeferral: options.a2aV2Service.notEnrolledDeferral(),
          a2aV2ReadinessOutage: options.a2aV2Service.readinessOutage(),
        }
      : {}),
  });

/**
 * r9: a request for one of the all-supervisor routes, when V2 serves them;
 * 503 `v2-unavailable` for anything under a configured routePath while V2 is
 * disabled (V1 unaffected); otherwise undefined.
 */
const allSupervisorsResponse = (
  options: LoopOrchestrationFetchHandlerOptions,
  request: Request,
  pathname: string
): Promise<Response> | undefined => {
  const route = options.a2aV2Service?.allSupervisorsRoute;
  if (route && matchA2AV2Route(route.routePath, pathname)) {
    return route.httpHandler(request);
  }
  const disabled = options.a2aV2Service
    ? undefined
    : options.a2aV2DisabledRoutePath?.();
  if (
    disabled &&
    (pathname === disabled || pathname.startsWith(`${disabled}/`))
  ) {
    return Promise.resolve(
      Response.json(
        { error: { code: "v2-unavailable" } },
        { headers: { "cache-control": "no-store" }, status: 503 }
      )
    );
  }
  return undefined;
};

/**
 * The one HTTP mount point for the existing V1 control surface and an
 * explicitly supplied V2 A2A service. It does not construct either host and
 * therefore cannot create a competing worker, listener, or recovery owner.
 */
export const createLoopOrchestrationFetchHandler = (
  options: LoopOrchestrationFetchHandlerOptions
): ((request: Request) => Promise<Response>) => {
  // The V1 surface refuses result graph ids; its refusal names the V2 route
  // that starts one instead, when this server mounts it.
  const v1Handler = options.host.httpHandler(options.authenticator, {
    resultGraphRoutePath: options.a2aV2Service?.resultGraphRoute?.pathname,
  });
  return (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Promise.resolve(orchestrationHealth(options));
    }
    const r9 = allSupervisorsResponse(options, request, url.pathname);
    if (r9) {
      return r9;
    }
    if (
      options.a2aV2Service &&
      (url.pathname === options.a2aV2Service.pathname ||
        options.a2aV2Service.pathnames?.includes(url.pathname))
    ) {
      return options.a2aV2Service.httpHandler(request);
    }
    const recipient = options.a2aV2Service?.recipientRoute;
    if (recipient && url.pathname === recipient.pathname) {
      return recipient.httpHandler(request);
    }
    const assignment = options.a2aV2Service?.assignmentRoute;
    if (assignment && url.pathname === assignment.pathname) {
      return assignment.httpHandler(request);
    }
    const resultGraph = options.a2aV2Service?.resultGraphRoute;
    if (resultGraph && url.pathname === resultGraph.pathname) {
      return resultGraph.httpHandler(request);
    }
    return v1Handler(request);
  };
};

/**
 * Absent means no waking at all, which is the default and leaves the service
 * behaving exactly as it did before.
 */
const parseWake = (value: unknown): WakeConfig | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("orchestration wake is invalid");
  }
  exactKeys(value, ["intervalMs"], "orchestration wake");
  const intervalMs = value.intervalMs;
  if (
    !(
      Number.isSafeInteger(intervalMs) &&
      Number(intervalMs) >= 1000 &&
      Number(intervalMs) <= 3_600_000
    )
  ) {
    throw new Error("orchestration wake intervalMs is invalid");
  }
  return { intervalMs: Number(intervalMs) };
};

const requireRoutePath = (value: unknown, label: string): string => {
  const routePath = required(value, ROUTE_PATH_RE, label);
  if (
    routePath === "/healthz" ||
    routePath === "/api/v1" ||
    routePath.startsWith("/api/v1/")
  ) {
    throw new Error(`${label} collides with an existing orchestration route`);
  }
  return routePath;
};

const RETIRED_RESULT_ARTIFACT_KEYS = "artifactRef,commit,path,repositoryRoot";

/**
 * Migration guard for `a2aV2.resultArtifacts`. Entries used to be
 * `{artifactRef, commit, path, repositoryRoot}`, and such an artifact verified
 * for any graph task's acceptance receipt. That shape is refused at startup
 * with the exact fix rather than accepted: accepting it would restore the
 * defect. Each entry now also names the one graph task it is evidence for,
 * and the graph must be a message-derived result graph, since no other graph
 * can ever be bound: the keyed id
 * (`deriveSupervisorMessageV2ResultGraphWorkflowId(key, scope, message)`,
 * computed with `loop orchestration result-graph-id`), or the unkeyed v2 id
 * of a binding recorded before the key existed.
 */
const assertCurrentResultArtifactShape = (
  entry: unknown,
  index: number
): void => {
  const label = `orchestration a2aV2 resultArtifacts[${index}]`;
  if (!isRecord(entry)) {
    throw new Error(`${label} is invalid`);
  }
  if (Object.keys(entry).sort().join(",") === RETIRED_RESULT_ARTIFACT_KEYS) {
    throw new Error(
      `${label} uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId naming the one graph task this artifact is evidence for (graphWorkflowId is the graph the result's binding is recorded under; only for a message not bound yet, compute it with \`loop orchestration result-graph-id\`)`
    );
  }
  if (
    typeof entry.graphWorkflowId === "string" &&
    !SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE.test(
      entry.graphWorkflowId
    ) &&
    !SUPERVISOR_MESSAGE_V2_LEGACY_RESULT_GRAPH_WORKFLOW_ID_RE.test(
      entry.graphWorkflowId
    )
  ) {
    throw new Error(
      `${label} graphWorkflowId is not a message-derived result graph (supervisor-result-graph:v3:<hmac-sha256>, from \`loop orchestration result-graph-id\`), so no result could ever bind to it`
    );
  }
};

const MAX_PREVIOUS_RESULT_GRAPH_KEYS = 8;

/**
 * `a2aV2.previousResultGraphKeyEnvs`: one to eight distinct environment
 * variable names (never secrets), none the primary's, beside a primary.
 */
const parsePreviousResultGraphKeyEnvs = (
  value: unknown,
  resultGraphKeyEnv: string | undefined
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!resultGraphKeyEnv) {
    throw new Error(
      "orchestration a2aV2 previousResultGraphKeyEnvs requires resultGraphKeyEnv"
    );
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PREVIOUS_RESULT_GRAPH_KEYS ||
    value.some(
      (name) => typeof name !== "string" || !TOKEN_ENV_RE.test(name)
    ) ||
    new Set([resultGraphKeyEnv, ...value]).size !== value.length + 1
  ) {
    throw new Error(
      "orchestration a2aV2 previousResultGraphKeyEnvs is invalid"
    );
  }
  return [...(value as string[])];
};

/**
 * The control principal must be a configured supervisor's. r9: the recipient
 * is optional; named, it is r8's manifest-bound seat and must be a Loop
 * binding, exactly as before.
 */
const parseA2AV2Recipient = (
  value: unknown,
  principal: string,
  supervisors: readonly SupervisorConfig[]
): string | undefined => {
  const recipient =
    value === undefined
      ? undefined
      : required(value, SUPERVISOR_RE, "orchestration a2aV2 recipient");
  if (!supervisors.some((supervisor) => supervisor.principal === principal)) {
    throw new Error("orchestration a2aV2 principal is not configured");
  }
  if (recipient === undefined) {
    return undefined;
  }
  if (
    !supervisors.find((supervisor) => supervisor.supervisorId === recipient)
      ?.manifestPath
  ) {
    throw new Error("orchestration a2aV2 recipient is not a Loop binding");
  }
  return recipient;
};

const parseA2AV2 = (
  value: unknown,
  supervisors: readonly SupervisorConfig[]
): A2AV2Config | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("orchestration a2aV2 is invalid");
  }
  exactKeys(
    value,
    [
      "databaseUrlEnv",
      "endpointRef",
      "policy",
      "principal",
      ...(value.recipient === undefined ? [] : ["recipient"]),
      "routePath",
      "sessionTtlMs",
      "tenant",
      ...(value.resultArtifacts === undefined ? [] : ["resultArtifacts"]),
      ...(value.resultGraphKeyEnv === undefined ? [] : ["resultGraphKeyEnv"]),
      ...(value.previousResultGraphKeyEnvs === undefined
        ? []
        : ["previousResultGraphKeyEnvs"]),
      ...(value.readinessOutageBoundMs === undefined
        ? []
        : ["readinessOutageBoundMs"]),
      ...(value.workflowIdFormat === undefined ? [] : ["workflowIdFormat"]),
      ...(value.notEnrolledBoundMs === undefined ? [] : ["notEnrolledBoundMs"]),
    ],
    "orchestration a2aV2"
  );
  if (!isRecord(value.policy)) {
    throw new Error("orchestration a2aV2 policy is invalid");
  }
  exactKeys(
    value.policy,
    [
      "claimTimeoutMs",
      "escalationTimeoutMs",
      "maxDeliveryAttempts",
      "retryDelayMs",
    ],
    "orchestration a2aV2 policy"
  );
  const positiveDuration = (candidate: unknown, label: string): number => {
    if (
      !(
        Number.isSafeInteger(candidate) &&
        Number(candidate) >= 1000 &&
        Number(candidate) <= 86_400_000
      )
    ) {
      throw new Error(`${label} is invalid`);
    }
    return Number(candidate);
  };
  const policy = {
    claimTimeoutMs: positiveDuration(
      value.policy.claimTimeoutMs,
      "orchestration a2aV2 claimTimeoutMs"
    ),
    escalationTimeoutMs: positiveDuration(
      value.policy.escalationTimeoutMs,
      "orchestration a2aV2 escalationTimeoutMs"
    ),
    maxDeliveryAttempts: (() => {
      const attempts = value.policy.maxDeliveryAttempts;
      if (
        !(
          Number.isSafeInteger(attempts) &&
          Number(attempts) >= 1 &&
          Number(attempts) <= 100
        )
      ) {
        throw new Error("orchestration a2aV2 maxDeliveryAttempts is invalid");
      }
      return Number(attempts);
    })(),
    retryDelayMs: positiveDuration(
      value.policy.retryDelayMs,
      "orchestration a2aV2 retryDelayMs"
    ),
  };
  if (policy.escalationTimeoutMs < policy.claimTimeoutMs) {
    throw new Error("orchestration a2aV2 policy ordering is invalid");
  }
  const principal = required(
    value.principal,
    V2_PRINCIPAL_RE,
    "orchestration a2aV2 principal"
  );
  const recipient = parseA2AV2Recipient(
    value.recipient,
    principal,
    supervisors
  );
  const resultGraphKeyEnv =
    value.resultGraphKeyEnv === undefined
      ? undefined
      : required(
          value.resultGraphKeyEnv,
          TOKEN_ENV_RE,
          "orchestration a2aV2 resultGraphKeyEnv"
        );
  if (
    Array.isArray(value.resultArtifacts) &&
    value.resultArtifacts.length > 0 &&
    !resultGraphKeyEnv
  ) {
    // Never tell an operator to recompute ids: a binding keeps the graph it
    // was recorded under, and a recomputed id would stop it publishing.
    throw new Error(
      "orchestration a2aV2 resultArtifacts requires resultGraphKeyEnv: name the environment variable holding the host's result graph HMAC key (at least 32 bytes). Keep every existing resultArtifacts graphWorkflowId as it is: a recorded binding keeps the graph it was bound to, and a recomputed id would stop it publishing. Run `loop orchestration result-graph-id <config-path> <message-workflow-id>` only for a message that is not bound yet. To change the key later, first bind every result graph started under the old key (a graph started but not bound when its key becomes a previous key can never be bound, and must be started again under the new key), then move the old key's variable name to previousResultGraphKeyEnvs instead of replacing it"
    );
  }
  const previousResultGraphKeyEnvs = parsePreviousResultGraphKeyEnvs(
    value.previousResultGraphKeyEnvs,
    resultGraphKeyEnv
  );
  return {
    ...(resultGraphKeyEnv ? { resultGraphKeyEnv } : {}),
    ...(previousResultGraphKeyEnvs ? { previousResultGraphKeyEnvs } : {}),
    resultArtifacts: (() => {
      if (value.resultArtifacts === undefined) {
        return undefined;
      }
      if (!Array.isArray(value.resultArtifacts)) {
        throw new Error("orchestration resultArtifacts must be an array");
      }
      value.resultArtifacts.forEach(assertCurrentResultArtifactShape);
      const entries = value.resultArtifacts as GitResultArtifactBinding[];
      createGitResultArtifactVerifier(entries);
      return entries.map((entry) => ({ ...entry }));
    })(),
    databaseUrlEnv: required(
      value.databaseUrlEnv,
      TOKEN_ENV_RE,
      "orchestration a2aV2 databaseUrlEnv"
    ),
    endpointRef: required(
      value.endpointRef,
      ENDPOINT_REF_RE,
      "orchestration a2aV2 endpointRef"
    ),
    ...(value.notEnrolledBoundMs === undefined
      ? {}
      : {
          notEnrolledBoundMs: positiveDuration(
            value.notEnrolledBoundMs,
            "orchestration a2aV2 notEnrolledBoundMs"
          ),
        }),
    policy,
    principal,
    ...(value.readinessOutageBoundMs === undefined
      ? {}
      : {
          readinessOutageBoundMs: positiveDuration(
            value.readinessOutageBoundMs,
            "orchestration a2aV2 readinessOutageBoundMs"
          ),
        }),
    ...(recipient === undefined ? {} : { recipient }),
    routePath: requireRoutePath(
      value.routePath,
      "orchestration a2aV2 routePath"
    ),
    sessionTtlMs: positiveDuration(
      value.sessionTtlMs,
      "orchestration a2aV2 sessionTtlMs"
    ),
    tenant: required(value.tenant, V2_TENANT_RE, "orchestration a2aV2 tenant"),
    ...(value.workflowIdFormat === undefined
      ? {}
      : { workflowIdFormat: parseWorkflowIdFormat(value.workflowIdFormat) }),
  };
};

const parseWorkflowIdFormat = (
  value: unknown
): SupervisorMessageV2WorkflowIdFormat => {
  if (
    !(SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS as readonly unknown[]).includes(
      value
    )
  ) {
    throw new Error(
      'orchestration a2aV2 workflowIdFormat must be "legacy" or "deployment"'
    );
  }
  return value as SupervisorMessageV2WorkflowIdFormat;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has invalid fields`);
  }
};

const required = (value: unknown, pattern: RegExp, label: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

/**
 * The host secret keying result graph ids, read from the operator-named
 * environment variable. Errors name the variable, never its value.
 */
const resolveResultGraphKeyEnv = (
  name: string,
  env: NodeJS.ProcessEnv
): SupervisorResultGraphKey => {
  const secret = env[name];
  if (!secret) {
    throw new Error(
      `missing orchestration A2A V2 result graph key environment ${name}`
    );
  }
  try {
    return SupervisorResultGraphKey.fromSecret(secret);
  } catch {
    throw new Error(
      `orchestration A2A V2 result graph key environment ${name} must hold at least 32 bytes`
    );
  }
};

/** A configured result graph key with the variable that holds it. */
interface ConfiguredResultGraphKey {
  env: string;
  key: SupervisorResultGraphKey;
  role: "previous" | "primary";
}

/**
 * Every configured result graph key, the primary first. Two variables
 * holding the same key are refused, named by variable and fingerprint.
 */
const resolveResultGraphKeys = (
  config: A2AV2Config,
  env: NodeJS.ProcessEnv
): ConfiguredResultGraphKey[] => {
  if (!config.resultGraphKeyEnv) {
    return [];
  }
  const keys: ConfiguredResultGraphKey[] = [
    {
      env: config.resultGraphKeyEnv,
      key: resolveResultGraphKeyEnv(config.resultGraphKeyEnv, env),
      role: "primary",
    },
    ...(config.previousResultGraphKeyEnvs ?? []).map((name) => ({
      env: name,
      key: resolveResultGraphKeyEnv(name, env),
      role: "previous" as const,
    })),
  ];
  for (const [index, entry] of keys.entries()) {
    const earlier = keys
      .slice(0, index)
      .find((other) => other.key.fingerprint === entry.key.fingerprint);
    if (earlier) {
      throw new Error(
        `orchestration A2A V2 result graph key environments ${earlier.env} and ${entry.env} hold the same key (${entry.key.fingerprint})`
      );
    }
  }
  return keys;
};

const resolveResultGraphKey = (
  config: A2AV2Config,
  env: NodeJS.ProcessEnv
): SupervisorResultGraphKey | undefined =>
  resolveResultGraphKeys(config, env).find((entry) => entry.role === "primary")
    ?.key;

const readConfigFile = (path: string): unknown => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("orchestration config is not a file");
    }
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

export const parseLoopOrchestrationConfig = (value: unknown): ServerConfig => {
  if (!isRecord(value)) {
    throw new Error("orchestration config must be an object");
  }
  const topLevel = Object.keys(value).filter(
    (key) => key !== "a2aV2" && key !== "deadlines" && key !== "wake"
  );
  exactKeys(
    Object.fromEntries(topLevel.map((key) => [key, value[key]])),
    [
      "address",
      "buildId",
      "grants",
      "hostname",
      "identity",
      "namespace",
      "port",
      "schema",
      "stateDir",
      "supervisors",
      "taskQueue",
    ],
    "orchestration config"
  );
  if (value.schema !== "loop-orchestration-server.v1") {
    throw new Error("orchestration config schema is invalid");
  }
  if (!Array.isArray(value.supervisors) || value.supervisors.length === 0) {
    throw new Error("orchestration supervisors are required");
  }
  const supervisors = value.supervisors.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("orchestration supervisor is invalid");
    }
    const keys = Object.keys(entry).sort();
    const allowed = new Set([
      "mailbox",
      "manifestPath",
      "principal",
      "seat",
      "supervisorId",
      "tokenEnv",
      "wakeSession",
    ]);
    if (
      keys.some((key) => !allowed.has(key)) ||
      !["principal", "supervisorId", "tokenEnv"].every((key) =>
        keys.includes(key)
      ) ||
      // A recipient must be reachable some way: a live pane, a mailbox, or both.
      !(keys.includes("manifestPath") || keys.includes("mailbox"))
    ) {
      throw new Error("orchestration supervisor has invalid fields");
    }
    return {
      ...(entry.seat === undefined
        ? {}
        : {
            seat: required(entry.seat, SEAT_RE, "seat") as "claude" | "codex",
          }),
      ...(entry.mailbox === undefined
        ? {}
        : { mailbox: required(entry.mailbox, ABSOLUTE_PATH_RE, "mailbox") }),
      ...(entry.wakeSession === undefined
        ? {}
        : {
            wakeSession: required(
              entry.wakeSession,
              SESSION_NAME_RE,
              "wakeSession"
            ),
          }),
      ...(entry.manifestPath === undefined
        ? {}
        : {
            manifestPath: required(
              entry.manifestPath,
              ABSOLUTE_PATH_RE,
              "manifestPath"
            ),
          }),
      principal: required(entry.principal, NAME_RE, "principal"),
      supervisorId: required(entry.supervisorId, SUPERVISOR_RE, "supervisorId"),
      tokenEnv: required(entry.tokenEnv, TOKEN_ENV_RE, "tokenEnv"),
    };
  });
  if (!Array.isArray(value.grants) || value.grants.length === 0) {
    throw new Error("orchestration grants are required");
  }
  const grants = value.grants.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("orchestration grant is invalid");
    }
    exactKeys(entry, ["from", "operations", "principal", "to"], "grant");
    if (
      !Array.isArray(entry.operations) ||
      entry.operations.length === 0 ||
      !entry.operations.every(
        (operation): operation is SupervisorMessageGovernedOperation =>
          typeof operation === "string" &&
          OPERATIONS.has(operation as SupervisorMessageGovernedOperation)
      )
    ) {
      throw new Error("grant operations are invalid");
    }
    return {
      from: required(entry.from, SUPERVISOR_RE, "grant from"),
      operations: [...new Set(entry.operations)].sort(),
      principal: required(entry.principal, NAME_RE, "grant principal"),
      to: required(entry.to, SUPERVISOR_RE, "grant to"),
    };
  });
  const port = value.port;
  if (
    !(
      Number.isSafeInteger(port) &&
      Number(port) >= 1024 &&
      Number(port) <= 65_535
    )
  ) {
    throw new Error("orchestration port is invalid");
  }
  const deadlines = value.deadlines;
  let deadlineConfig: DeadlineConfig | undefined;
  if (deadlines !== undefined) {
    if (!isRecord(deadlines)) {
      throw new Error("orchestration deadlines is invalid");
    }
    exactKeys(deadlines, ["intervalMs"], "orchestration deadlines");
    const intervalMs = deadlines.intervalMs;
    if (
      !(
        Number.isSafeInteger(intervalMs) &&
        Number(intervalMs) >= 1000 &&
        Number(intervalMs) <= 3_600_000
      )
    ) {
      throw new Error("orchestration deadlines intervalMs is invalid");
    }
    deadlineConfig = { intervalMs: Number(intervalMs) };
  }
  const wakeConfig = parseWake(value.wake);
  const a2aV2 = parseA2AV2(value.a2aV2, supervisors);
  return {
    address: required(value.address, TEMPORAL_ADDRESS_RE, "address"),
    ...(a2aV2 ? { a2aV2 } : {}),
    buildId: required(value.buildId, NAME_RE, "buildId"),
    ...(deadlineConfig ? { deadlines: deadlineConfig } : {}),
    grants,
    hostname: required(value.hostname, HOST_RE, "hostname"),
    identity: required(value.identity, NAME_RE, "identity"),
    namespace: required(value.namespace, NAME_RE, "namespace"),
    port: Number(port),
    stateDir: required(value.stateDir, ABSOLUTE_PATH_RE, "stateDir"),
    supervisors,
    taskQueue: required(value.taskQueue, NAME_RE, "taskQueue"),
    ...(wakeConfig ? { wake: wakeConfig } : {}),
  };
};

const equalToken = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const authenticator = (
  config: ServerConfig,
  env: NodeJS.ProcessEnv
): SupervisorControlSurfaceAuthenticator => ({
  authenticate(request): SupervisorControlSurfaceIdentity | undefined {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      return undefined;
    }
    const token = authorization.slice("Bearer ".length);
    for (const supervisor of config.supervisors) {
      const expected = env[supervisor.tokenEnv];
      if (expected && equalToken(token, expected)) {
        return {
          principal: supervisor.principal,
          supervisorId: supervisor.supervisorId,
        };
      }
    }
    return undefined;
  },
});

const authority = (config: ServerConfig): SupervisorMessageAuthorityPort => ({
  decide(request) {
    const allowed = config.grants.some(
      (grant) =>
        grant.principal === request.principal &&
        grant.from === request.from &&
        grant.to === request.to &&
        grant.operations.includes(request.operation)
    );
    return {
      allowed,
      authorityRef: allowed
        ? "authority:loop-orchestration-config"
        : "authority:deny-default",
      reasonCode: allowed ? "configured-grant" : "no-configured-grant",
    };
  },
});

const a2aAuthenticator = (
  base: SupervisorControlSurfaceAuthenticator,
  config: A2AV2Config
) => ({
  async authenticate(
    request: Request
  ): Promise<SupervisorControlSurfaceIdentity | undefined> {
    const identity = await base.authenticate(request);
    return identity?.principal === config.principal ? identity : undefined;
  },
});

/** A config naming the one seat an r8 enrollment acts on. */
type A2AV2SeatConfig = A2AV2Config & { recipient: string };

interface A2AV2EnrollmentInput {
  config: A2AV2SeatConfig;
  directory: SupervisorBridgeDirectory;
  /**
   * r9: whether the seat has an endpoint lease row. Such a seat is routed by
   * its lease, so r8's enrollment leaves its descriptor alone.
   */
  leaseHeld?(recipient: string): Promise<boolean>;
  now: () => string;
  service: Pick<
    SupervisorA2AV2Service,
    "currentSession" | "rebindSession" | "registerSession"
  >;
  status?: typeof readBridgeStatus;
}

interface ObservedA2AV2Session {
  endpointDigest: string;
  provider: SupervisorSessionDescriptorV2["provider"];
  sessionRef: string;
}

// Losing a race is retried against the re-read revision, at most this often.
const ENROLLMENT_ATTEMPTS = 3;
const ENROLLMENT_RETRY_MS = 5000;

/**
 * A descriptor is renewed once less than half its lifetime remains, so the
 * renewal lands while deliveries are still accepted instead of after
 * `assertReady` has begun refusing them as expired.
 */
const enrolledAs = (
  current: SupervisorSessionDescriptorV2 | undefined,
  observed: ObservedA2AV2Session,
  config: A2AV2Config,
  now: string
): boolean =>
  current !== undefined &&
  current.endpointDigest === observed.endpointDigest &&
  current.endpointRef === config.endpointRef &&
  current.provider === observed.provider &&
  current.sessionRef === observed.sessionRef &&
  Date.parse(current.expiresAt) - Date.parse(now) >
    Math.floor(config.sessionTtlMs / 2);

/**
 * The one enrollment failure that means the seat is simply not running or
 * not reachable now: its run is not active (no route), or its provider
 * session is absent from the run. Since fix8 no enrollment failure refuses
 * start (see `ConfiguredA2AV2SessionEnrollment`); the class still tells an
 * operator reading the log a stopped seat from a denial or a conflict.
 */
export class A2AV2SeatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AV2SeatUnavailableError";
  }
}

const observeConfiguredA2AV2Session = async (
  input: Pick<A2AV2EnrollmentInput, "config" | "directory" | "status">
): Promise<ObservedA2AV2Session> => {
  const route = await input.directory.resolve(input.config.recipient);
  if (!route) {
    throw new A2AV2SeatUnavailableError(
      "configured A2A V2 recipient seat is not running"
    );
  }
  if (route.target !== "codex" && route.target !== "claude") {
    throw new Error(
      "configured A2A V2 recipient has no supported provider route"
    );
  }
  const status = (input.status ?? readBridgeStatus)(route.runDir);
  const endpoint =
    route.target === "codex"
      ? status.codexRemoteUrl
      : status.claudeChannelServer;
  const sessionId =
    route.target === "codex" ? status.codexThreadId : status.claudeSessionId;
  const provider =
    route.target === "codex" ? "codex-app-server" : "claude-code";
  if (!(endpoint && sessionId)) {
    throw new A2AV2SeatUnavailableError(
      "configured A2A V2 recipient session is unavailable"
    );
  }
  return {
    endpointDigest: createHash("sha256").update(endpoint).digest("hex"),
    provider,
    sessionRef: `session:${sessionId}`,
  };
};

/**
 * Registers, renews, or rebinds one configured seat's session descriptor
 * through the store's governed register/rebind path. Another server instance
 * enrolling the same seat at the same moment is not an error: a failed write is
 * followed by a re-read, and the result converges on whatever the winner wrote
 * when it already describes this seat, or retries against the new revision.
 * A failure with no competing write (a denial, a conflict) is still thrown.
 */
export const enrollConfiguredA2AV2Session = async (
  input: A2AV2EnrollmentInput
): Promise<SupervisorSessionDescriptorV2> => {
  const scope = {
    principal: input.config.principal,
    tenantId: input.config.tenant,
  };
  const observed = await observeConfiguredA2AV2Session(input);
  let failure: { error: unknown; revision: number } | undefined;
  for (let attempt = 0; attempt < ENROLLMENT_ATTEMPTS; attempt += 1) {
    const issuedAt = input.now();
    const current = await input.service.currentSession(
      scope,
      input.config.recipient
    );
    if (current && enrolledAs(current, observed, input.config, issuedAt)) {
      return current;
    }
    const revision = current?.revision ?? 0;
    if (failure && failure.revision === revision) {
      throw failure.error;
    }
    const descriptor: SupervisorSessionDescriptorV2 = {
      descriptorId: deriveSupervisorSessionDescriptorV2Id(
        scope,
        input.config.recipient
      ),
      endpointDigest: observed.endpointDigest,
      endpointRef: input.config.endpointRef,
      expiresAt: new Date(
        Date.parse(issuedAt) + input.config.sessionTtlMs
      ).toISOString(),
      issuedAt,
      principal: scope.principal,
      provider: observed.provider,
      recipient: input.config.recipient,
      revision: revision + 1,
      schema: "supervisor-session-descriptor.v2",
      sessionRef: observed.sessionRef,
      tenantId: scope.tenantId,
    };
    try {
      return current
        ? (await input.service.rebindSession(scope, descriptor)).descriptor
        : await input.service.registerSession(scope, descriptor);
    } catch (error) {
      failure = { error, revision };
    }
  }
  throw failure?.error;
};

/**
 * One seat's result from one `maintain()` pass.
 * - `unchanged`: the seat still matches the descriptor this process last
 *   enrolled, checked against local bridge status only (no store call).
 * - `enrolled`: the session store now holds a current descriptor for the
 *   seat: registered, renewed, rebound, or converged on a competing write.
 * - `deferred`: the seat failed recently and is waiting out its retry delay;
 *   it was not attempted, so nothing is known about it now.
 * - `failed`: the attempt failed; the seat is retried after the delay.
 */
export type A2AV2EnrollmentOutcome =
  | {
      recipient: string;
      /** r9 only: the server released a lease whose run ended, or the lease
       * row the sweep tracked is gone or released. */
      state: "deferred" | "enrolled" | "leased" | "released" | "unchanged";
    }
  | { error: unknown; recipient: string; state: "failed" };

/**
 * Keeps every configured seat's descriptor current for the life of the
 * server, not only at start: it renews before expiry and rebinds when a Codex
 * thread or Claude session restarts. It owns no timer; the server's existing
 * reconciliation sweep calls `maintain()`. Between writes it compares the
 * seat's bridge status with the descriptor it last enrolled, so a quiet sweep
 * reads local files only. A failed seat is retried after a short delay, and
 * is reported as `deferred` (not as a success) until then.
 *
 * fix8: enrollment is per recipient and never refuses start, for the
 * configured recipient as for a peer, whatever the cause (its run stopped,
 * its manifest missing, its session absent, an authority denial, a
 * registration conflict). The start-time pass only seeds the sweep: a seat
 * that failed is reported as not enrolled (a log line, a count on /healthz,
 * the seat id on the authenticated assignment status) and retried by the
 * existing reconciliation sweep. While a recipient is not enrolled, its
 * deliveries wait without spending attempts up to the not-enrolled bound
 * (see `SupervisorMessageV2NotEnrolledDeferral`), then fail as normal
 * retryable attempts.
 */
export class ConfiguredA2AV2SessionEnrollment {
  readonly #enrolled = new Map<string, SupervisorSessionDescriptorV2>();
  readonly #input: A2AV2EnrollmentInput;
  /** When each failing seat's current failure began (epoch ms). */
  readonly #notEnrolledSince = new Map<string, number>();
  readonly #recipients: readonly string[];
  readonly #retryAt = new Map<string, number>();

  constructor(
    input: Omit<A2AV2EnrollmentInput, "config"> & {
      config: A2AV2Config;
      recipients: readonly string[];
    }
  ) {
    const { recipients, ...enrollment } = input;
    this.#input = {
      ...enrollment,
      config: { ...enrollment.config, recipient: recipients[0] ?? "" },
    };
    this.#recipients = recipients;
  }

  async maintain(): Promise<A2AV2EnrollmentOutcome[]> {
    const outcomes: A2AV2EnrollmentOutcome[] = [];
    for (const recipient of this.#recipients) {
      outcomes.push(await this.#maintainOne(recipient));
    }
    return outcomes;
  }

  /** The seats whose last attempt failed, sorted, until a pass enrolls them. */
  notEnrolled(): string[] {
    return [...this.#notEnrolledSince.keys()].sort();
  }

  /**
   * When this seat's current failure to enroll began (epoch ms): kept across
   * retries and retry delays, cleared once a pass enrolls it. Undefined for
   * an enrolled seat and for one this enrollment does not manage.
   */
  notEnrolledSince(recipient: string): number | undefined {
    return this.#notEnrolledSince.get(recipient);
  }

  async #maintainOne(recipient: string): Promise<A2AV2EnrollmentOutcome> {
    const now = this.#input.now();
    if (Date.parse(now) < (this.#retryAt.get(recipient) ?? 0)) {
      return { recipient, state: "deferred" };
    }
    try {
      if (await this.#input.leaseHeld?.(recipient)) {
        this.#enrolled.delete(recipient);
        this.#retryAt.delete(recipient);
        this.#notEnrolledSince.delete(recipient);
        return { recipient, state: "leased" };
      }
    } catch {
      // The lease store cannot answer: keep r8's enrollment of the seat.
    }
    const input = {
      ...this.#input,
      config: { ...this.#input.config, recipient },
    };
    try {
      if (
        enrolledAs(
          this.#enrolled.get(recipient),
          await observeConfiguredA2AV2Session(input),
          input.config,
          now
        )
      ) {
        // Only a seat enrolled since its last failure is unchanged.
        return { recipient, state: "unchanged" };
      }
      this.#enrolled.set(recipient, await enrollConfiguredA2AV2Session(input));
      this.#retryAt.delete(recipient);
      this.#notEnrolledSince.delete(recipient);
      return { recipient, state: "enrolled" };
    } catch (error) {
      this.#enrolled.delete(recipient);
      if (!this.#notEnrolledSince.has(recipient)) {
        this.#notEnrolledSince.set(recipient, Date.parse(now));
      }
      this.#retryAt.set(
        recipient,
        Date.parse(now) +
          Math.min(
            ENROLLMENT_RETRY_MS,
            Math.floor(input.config.sessionTtlMs / 4)
          )
      );
      return { error, recipient, state: "failed" };
    }
  }
}

/**
 * What one sweep pass found about a lease's session.
 * - `live`: the session is there (its run active, its probe ready).
 * - `terminal`: the lease's run ended (completed, failed or stopped).
 * - `unavailable`: the locator no longer resolves, the run's manifest is
 *   unreadable, or the probe failed. Nothing is renewed: the TTL lapses.
 * - `unobserved`: the server has no way to observe this kind (no probe is
 *   wired); it neither renews nor reports it, and the holder renews itself.
 */
export type SupervisorEndpointLeaseObservation =
  | "live"
  | "terminal"
  | "unavailable"
  | "unobserved";

/** A resolved run's manifest: unreadable, ended, or (undefined) active. */
const runObservation = (
  runDir: string,
  readManifest: (
    path: string
  ) => { state: Parameters<typeof isActiveRunState>[0] } | undefined
): "terminal" | "unavailable" | undefined => {
  const manifest = readManifest(
    join(runDir, SUPERVISOR_ENDPOINT_MANIFEST_FILE)
  );
  if (!manifest) {
    return "unavailable";
  }
  return isActiveRunState(manifest.state) ? undefined : "terminal";
};

/**
 * The server's observation of a lease. SECURITY: the stored locator is
 * untrusted ids, so it is re-resolved here on every pass with the server's
 * own resolver (realpath containment, manifest binding, loopback-only Codex
 * URL); a refusal is `unavailable`. The run's state is read from the manifest
 * the resolver checked; the kind's readiness probe (T2), when wired, decides
 * liveness.
 */
export const createSupervisorEndpointLeaseObserver =
  (deps: {
    probe?(lease: SupervisorEndpointLeaseV2): Promise<boolean>;
    readManifest?(
      path: string
    ): { state: Parameters<typeof isActiveRunState>[0] } | undefined;
    resolveLocator: SupervisorEndpointLocatorResolver;
  }) =>
  async (
    lease: SupervisorEndpointLeaseV2
  ): Promise<SupervisorEndpointLeaseObservation> => {
    let resolved: ReturnType<SupervisorEndpointLocatorResolver>;
    try {
      resolved = deps.resolveLocator(lease.locator, lease.recipient);
    } catch {
      return "unavailable";
    }
    const run =
      resolved.kind === "claude-channel"
        ? undefined
        : runObservation(resolved.runDir, deps.readManifest ?? readRunManifest);
    if (run) {
      return run;
    }
    if (deps.probe) {
      try {
        return (await deps.probe(lease)) ? "live" : "unavailable";
      } catch {
        return "unavailable";
      }
    }
    return resolved.kind === "claude-channel" ? "unobserved" : "live";
  };

// A lease pass lists the store at most this often (and at most every quarter
// TTL), riding the existing reconciliation sweep: no scheduler of its own.
const LEASE_PASS_MS = 5000;

export interface SupervisorEndpointLeaseEnrollmentInput {
  leases: Pick<SupervisorEndpointLeaseStore, "list" | "release" | "renew">;
  log: (line: string) => void;
  now: () => string;
  observe(
    lease: SupervisorEndpointLeaseV2
  ): Promise<SupervisorEndpointLeaseObservation>;
  principalForRecipient(recipient: string): string | undefined;
  sessionTtlMs: number;
  tenant: string;
}

/**
 * r9: the enrollment sweep generalized from r8's configured seats to every
 * live endpoint lease of this tenant. It owns no timer; the existing
 * reconciliation sweep calls `maintain()`. For each unreleased lease of a
 * configured supervisor, in that seat's scope:
 * - the run ended: the server releases the lease with its stored fence;
 * - the session is live: the lease is renewed (same fence) once less than
 *   half of `sessionTtlMs` remains; expiry alone never fences, so an expired
 *   lease whose session is back is renewed too;
 * - otherwise nothing is renewed and the TTL lapses; the seat is reported not
 *   enrolled (since the failure, or since its expiry), so deliveries defer
 *   within the not-enrolled bound.
 * A fenced renew or release (a newer claim) is left to the next pass. A row
 * of an unconfigured supervisor, another tenant or a foreign principal is
 * never acted on.
 */
export class SupervisorEndpointLeaseEnrollment {
  readonly #input: SupervisorEndpointLeaseEnrollmentInput;
  readonly #notEnrolledSince = new Map<string, number>();
  #listFailure: string | undefined;
  #nextPassAt = 0;

  constructor(input: SupervisorEndpointLeaseEnrollmentInput) {
    this.#input = input;
  }

  async maintain(): Promise<A2AV2EnrollmentOutcome[]> {
    const now = Date.parse(this.#input.now());
    if (now < this.#nextPassAt) {
      return [];
    }
    this.#nextPassAt =
      now + Math.min(LEASE_PASS_MS, Math.floor(this.#input.sessionTtlMs / 4));
    let leases: readonly SupervisorEndpointLeaseV2[];
    try {
      leases = await this.#input.leases.list(this.#input.tenant);
      this.#listFailure = undefined;
    } catch (error) {
      const message = failureMessage(error);
      if (message !== this.#listFailure) {
        this.#listFailure = message;
        this.#input.log(
          `orchestration A2A V2 endpoint lease sweep failed: ${message}`
        );
      }
      return [];
    }
    const outcomes: A2AV2EnrollmentOutcome[] = [];
    const seen = new Set<string>();
    for (const lease of leases) {
      const principal = this.#input.principalForRecipient(lease.recipient);
      if (
        lease.releasedAt !== null ||
        lease.tenantId !== this.#input.tenant ||
        principal === undefined ||
        lease.principal !== principal ||
        seen.has(lease.recipient)
      ) {
        continue;
      }
      seen.add(lease.recipient);
      outcomes.push(
        await this.#maintainOne(
          lease,
          { principal, tenantId: lease.tenantId },
          now
        )
      );
    }
    for (const recipient of [...this.#notEnrolledSince.keys()]) {
      if (!seen.has(recipient)) {
        // Its row is gone or released: nothing of this sweep's to report.
        this.#notEnrolledSince.delete(recipient);
        outcomes.push({ recipient, state: "released" });
      }
    }
    return outcomes;
  }

  notEnrolled(): string[] {
    return [...this.#notEnrolledSince.keys()].sort();
  }

  notEnrolledSince(recipient: string): number | undefined {
    return this.#notEnrolledSince.get(recipient);
  }

  async #maintainOne(
    lease: SupervisorEndpointLeaseV2,
    scope: { principal: string; tenantId: string },
    now: number
  ): Promise<A2AV2EnrollmentOutcome> {
    const recipient = lease.recipient;
    const fence = { epoch: lease.epoch, holderRef: lease.holderRef };
    let observation: SupervisorEndpointLeaseObservation;
    try {
      observation = await this.#input.observe(lease);
    } catch {
      observation = "unavailable";
    }
    try {
      if (observation === "terminal") {
        const released = await this.#input.leases.release({
          fence,
          recipient,
          scope,
        });
        if (released.status === "fenced") {
          return { recipient, state: "deferred" };
        }
        this.#notEnrolledSince.delete(recipient);
        return { recipient, state: "released" };
      }
      if (observation === "unobserved") {
        return supervisorEndpointLeaseState(lease, new Date(now)) === "live"
          ? { recipient, state: "unchanged" }
          : this.#failed(lease, now, SUPERVISOR_ENDPOINT_REASONS.leaseExpired);
      }
      if (observation === "unavailable") {
        return this.#failed(
          lease,
          now,
          SUPERVISOR_ENDPOINT_REASONS.probeFailed
        );
      }
      const wasFailing = this.#notEnrolledSince.has(recipient);
      if (
        Date.parse(lease.expiresAt) - now >
        Math.floor(this.#input.sessionTtlMs / 2)
      ) {
        this.#notEnrolledSince.delete(recipient);
        return { recipient, state: wasFailing ? "enrolled" : "unchanged" };
      }
      const renewed = await this.#input.leases.renew({
        fence,
        recipient,
        scope,
        ttlMs: this.#input.sessionTtlMs,
      });
      if (renewed.status === "fenced") {
        return { recipient, state: "deferred" };
      }
      if (renewed.status === "locator-refused") {
        return this.#failed(
          lease,
          now,
          SUPERVISOR_ENDPOINT_REASONS.locatorRefused
        );
      }
      this.#notEnrolledSince.delete(recipient);
      return { recipient, state: "enrolled" };
    } catch (error) {
      return this.#failed(lease, now, failureMessage(error));
    }
  }

  #failed(
    lease: SupervisorEndpointLeaseV2,
    now: number,
    reason: string
  ): A2AV2EnrollmentOutcome {
    if (!this.#notEnrolledSince.has(lease.recipient)) {
      const expiresAt = Date.parse(lease.expiresAt);
      this.#notEnrolledSince.set(
        lease.recipient,
        expiresAt <= now ? expiresAt : now
      );
    }
    return {
      error: new Error(reason),
      recipient: lease.recipient,
      state: "failed",
    };
  }
}

const SERVER_JSON_MAX_BYTES = 1024 * 1024;

/**
 * The filesystem the server's locator resolver touches: realpath, and JSON
 * read from a regular file only (no symlink, no FIFO or device: opened
 * non-blocking and checked before any read), bounded in size.
 */
export const serverSupervisorEndpointFs: SupervisorEndpointFs = {
  readJson(path) {
    const descriptor = openSync(
      path,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > SERVER_JSON_MAX_BYTES) {
        throw new Error("endpoint file is not a regular file");
      }
      return JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  },
  realpath: (path) => realpathSync(path),
};

const LEASE_ENDPOINT_REFS: readonly string[] = SUPERVISOR_ENDPOINT_KINDS.map(
  (kind) => supervisorEndpointRef(kind)
);

/**
 * The rebind rule. r8: a configured seat's descriptor in the control
 * principal's scope, same provider, the configured endpointRef. r9 (with
 * `principalForRecipient`): a lease-backed descriptor in the SEAT's own scope
 * {tenant, principalFor(recipient)}, from one `endpoint:<kind>` to another;
 * the provider may change with the kind (a claim's lease moves the seat).
 */
export const configuredA2AV2RebindAuthority = (
  config: A2AV2Config,
  recipients: readonly string[] = config.recipient ? [config.recipient] : [],
  principalForRecipient?: (recipient: string) => string | undefined
) => ({
  decide(input: {
    current: SupervisorSessionDescriptorV2;
    next: SupervisorSessionDescriptorV2;
    trustedScope: { principal: string; tenantId: string };
  }) {
    const sameDescriptor =
      input.trustedScope.tenantId === config.tenant &&
      input.next.recipient === input.current.recipient &&
      input.current.descriptorId === input.next.descriptorId;
    const seatPrincipal = principalForRecipient?.(input.current.recipient);
    const allowed =
      sameDescriptor &&
      ((input.trustedScope.principal === config.principal &&
        recipients.includes(input.current.recipient) &&
        // A lease-backed descriptor is never rebound back to r8's endpoint.
        !LEASE_ENDPOINT_REFS.includes(input.current.endpointRef) &&
        input.next.provider === input.current.provider &&
        input.next.endpointRef === config.endpointRef) ||
        (seatPrincipal !== undefined &&
          input.trustedScope.principal === seatPrincipal &&
          // Defense in depth: the store reads `current` by trustedScope, so
          // this holds in practice; a foreign or corrupt row is still refused.
          input.current.principal === seatPrincipal &&
          input.next.principal === seatPrincipal &&
          // A claim may take over r8's descriptor of the same seat scope.
          (LEASE_ENDPOINT_REFS.includes(input.current.endpointRef) ||
            input.current.endpointRef === config.endpointRef) &&
          LEASE_ENDPOINT_REFS.includes(input.next.endpointRef)));
    return {
      allowed,
      authorityRef: allowed
        ? "authority:loop-orchestration-config-a2a-v2-session"
        : "authority:deny-default",
      reasonCode: allowed
        ? "configured-session-rebind"
        : "no-configured-session-rebind",
    };
  },
});

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

/**
 * One tick of the server's existing reconciliation interval. Bridge and
 * mailbox ACK reconciliation keep their in-flight guard and own the health
 * verdict. Session enrollment rides the same tick under its own guard and is
 * not awaited by it, so a slow or hung session-store call cannot stop ACK
 * reconciliation for every recipient while /healthz still reports ready.
 * Enrollment is retried every tick. Each seat's failure is reported once per
 * change, and its recovery only when a later pass actually enrolled it: a
 * seat skipped while it waits out its retry delay has not recovered.
 */
export const createOrchestrationSweep = (input: {
  enrollment?: Pick<ConfiguredA2AV2SessionEnrollment, "maintain">;
  log: (line: string) => void;
  reconcilers: readonly { reconcile(): Promise<unknown> }[];
  setHealthy: (healthy: boolean) => void;
  /**
   * Receives the seats not enrolled now, sorted, after the start-time pass
   * and after every later pass: a seat whose last attempt failed, including
   * while it waits out its retry delay, until a pass enrolls it.
   */
  setNotEnrolled?: (recipients: readonly string[]) => void;
  /** The start-time pass, so a peer that start degraded is reported now. */
  startOutcomes?: readonly A2AV2EnrollmentOutcome[];
}): (() => Promise<void>) => {
  let enrolling = false;
  let reconciling = false;
  const reportedFailures = new Map<string, string>();
  let unexpectedFailure: string | undefined;
  const report = (outcomes: readonly A2AV2EnrollmentOutcome[]) => {
    for (const outcome of outcomes) {
      const reported = reportedFailures.get(outcome.recipient);
      if (outcome.state === "failed") {
        const message = failureMessage(outcome.error);
        if (message !== reported) {
          reportedFailures.set(outcome.recipient, message);
          input.log(
            `orchestration A2A V2 session enrollment failed for ${outcome.recipient}: ${message}`
          );
        }
      } else if (outcome.state === "enrolled" && reported !== undefined) {
        reportedFailures.delete(outcome.recipient);
        input.log(
          `orchestration A2A V2 session enrollment recovered for ${outcome.recipient}`
        );
      } else if (outcome.state === "leased") {
        // r8's enrollment handed the seat to its lease; the lease sweep
        // reports it from now on.
        reportedFailures.delete(outcome.recipient);
      } else if (outcome.state === "released") {
        reportedFailures.delete(outcome.recipient);
        input.log(
          `orchestration A2A V2 endpoint lease released for ${outcome.recipient}`
        );
      }
    }
    input.setNotEnrolled?.([...reportedFailures.keys()].sort());
  };
  report(input.startOutcomes ?? []);
  const enroll = (
    enrollment: Pick<ConfiguredA2AV2SessionEnrollment, "maintain">
  ) => {
    enrolling = true;
    enrollment
      .maintain()
      .then(
        (outcomes) => {
          unexpectedFailure = undefined;
          report(outcomes);
        },
        (error: unknown) => {
          // maintain() reports seat failures as outcomes; a rejection is a
          // defect in the pass itself, reported once per change.
          const message = failureMessage(error);
          if (message !== unexpectedFailure) {
            unexpectedFailure = message;
            input.log(
              `orchestration A2A V2 session enrollment pass failed: ${message}`
            );
          }
        }
      )
      .finally(() => {
        enrolling = false;
      });
  };
  return async () => {
    if (input.enrollment && !enrolling) {
      enroll(input.enrollment);
    }
    if (reconciling) {
      return;
    }
    reconciling = true;
    try {
      for (const reconciler of input.reconcilers) {
        await reconciler.reconcile();
      }
      input.setHealthy(true);
    } catch (error) {
      input.setHealthy(false);
      input.log(
        `orchestration bridge reconciliation failed: ${failureMessage(error)}`
      );
    } finally {
      reconciling = false;
    }
  };
};

const createDefaultRuntimeHost = async (input: {
  config: ServerConfig;
  configPath: string;
  connection: Connection;
  directory: LoopSupervisorDirectory;
  endpointRoots: SupervisorEndpointRoots;
  endpoints: A2AV2EndpointFactories;
  env: NodeJS.ProcessEnv;
  mailboxes: ReadonlyMap<string, string>;
  nativeConnection: NativeConnection;
}): Promise<{
  a2aV2Enrollment?: Pick<ConfiguredA2AV2SessionEnrollment, "maintain">;
  a2aV2Service: SupervisorA2AV2Service | undefined;
  /** Why a configured V2 plane did not start; V1 runs alone. */
  a2aV2StartFailure?: string;
  a2aV2StartOutcomes?: readonly A2AV2EnrollmentOutcome[];
  host: TemporalSupervisorRuntimeHost;
}> => {
  const delivery = new FirstAvailableDeliveryPort([
    new BridgeSupervisorMessageDeliveryPort({ directory: input.directory }),
    new MailboxSupervisorMessageDeliveryPort({
      directory: { resolveMailbox: (id) => input.mailboxes.get(id) },
    }),
  ]);
  // Fresh per host: a V2 start that fails closes the host it created, and
  // the V1-only host it falls back to must not share its stores.
  const makeHostOptions = () => ({
    authority: authority(input.config),
    buildId: input.config.buildId,
    delivery,
    identity: input.config.identity,
    namespace: input.config.namespace,
    nativeConnection: input.nativeConnection,
    receipts: new JsonlSupervisorMessageReceiptPort(
      join(input.config.stateDir, "governance.jsonl")
    ),
    store: new JsonlSupervisorThreadStore(
      join(input.config.stateDir, "threads.jsonl")
    ),
    taskQueue: input.config.taskQueue,
    workflowClient: new WorkflowClient({
      connection: input.connection,
      namespace: input.config.namespace,
    }),
    workflowBundle: {
      code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
        "utf8"
      ),
    },
    workflowExecution: "in-process" as const,
  });
  const v1Only = async () => ({
    a2aV2Service: undefined,
    host: await TemporalSupervisorRuntimeHost.create(makeHostOptions()),
  });
  const a2aConfig = input.config.a2aV2;
  if (!a2aConfig) {
    return await v1Only();
  }
  const hostOptions = makeHostOptions();
  // fix8: a V2 plane that cannot start is disabled, never fatal: the factory
  // releases what it acquired, and V1 starts on a host of its own.
  try {
    const databaseUrl = input.env[a2aConfig.databaseUrlEnv];
    if (!databaseUrl) {
      throw new Error("configured A2A V2 database environment is absent");
    }
    const controlAuthenticator = authenticator(input.config, input.env);
    const resultGraphKeys = resolveResultGraphKeys(a2aConfig, input.env);
    const supervisors = input.config.supervisors;
    const principalForRecipient = (recipient: string) =>
      supervisors.find((entry) => entry.supervisorId === recipient)?.principal;
    // r8: the one manifest-bound recipient and the seats sharing its run.
    const recipient = a2aConfig.recipient;
    const recipientBinding = recipient
      ? supervisors.find((entry) => entry.supervisorId === recipient)
      : undefined;
    const legacyPeers = recipient
      ? supervisors.filter(
          (entry) =>
            entry.seat &&
            entry.supervisorId !== recipient &&
            entry.manifestPath === recipientBinding?.manifestPath
        )
      : [];
    const legacySeats = recipient
      ? [recipient, ...legacyPeers.map((entry) => entry.supervisorId)]
      : [];
    // Without an r8 recipient the primary ingress (recovery only) is the
    // control principal's supervisor; its bare route is not served.
    const primarySupervisorId =
      recipient ??
      (
        supervisors.find((entry) => entry.principal === a2aConfig.principal) ??
        supervisors[0]
      )?.supervisorId ??
      "";
    // r9: the server's own roots and filesystem. A locator is untrusted ids
    // and never names a path or URL; this resolver derives them.
    const resolveLocator = createSupervisorEndpointLocatorResolver({
      fs: serverSupervisorEndpointFs,
      roots: input.endpointRoots,
    });
    const factories = input.endpoints;
    const connectLeases = factories.connectLeases;
    const endpointDelivery = factories.endpointDelivery;
    // The lease store opens after the session store whose provider readiness
    // needs it, so a lease-backed descriptor's readiness reads it late. Before
    // it is open (or without one) such a descriptor is not ready.
    let endpointLeaseReader: SupervisorEndpointLeaseReader | undefined;
    const endpointAdapters =
      factories.adapters?.() ?? createSupervisorEndpointKindAdapters();
    const endpointDescriptorReadiness = {
      ready: (descriptor: SupervisorSessionDescriptorV2) => {
        if (!endpointLeaseReader) {
          return Promise.reject(
            new Error(SUPERVISOR_ENDPOINT_REASONS.noEndpoint)
          );
        }
        return new SupervisorEndpointDescriptorReadiness({
          adapters: endpointAdapters,
          leases: endpointLeaseReader,
          resolveLocator,
        }).ready(descriptor);
      },
    };
    let r8Enrollment: ConfiguredA2AV2SessionEnrollment | undefined;
    let leaseEnrollment: SupervisorEndpointLeaseEnrollment | undefined;
    let a2aV2StartOutcomes: readonly A2AV2EnrollmentOutcome[] | undefined;
    const a2aV2Service = await createSupervisorA2AV2Service({
      allSupervisors: {
        authenticator: controlAuthenticator,
        ...(endpointDelivery
          ? {
              endpointDelivery: ({ leases, sessions }) => {
                endpointLeaseReader = leases;
                return endpointDelivery({
                  adapters: endpointAdapters,
                  leases,
                  mailboxes: input.mailboxes,
                  principalForRecipient,
                  resolveLocator,
                  sessions,
                });
              },
            }
          : {}),
        hasMailbox: (id) => input.mailboxes.has(id),
        legacySeats,
        log: (line) => console.error(line),
        mayReceive: (request) =>
          input.config.grants.some(
            (grant) =>
              grant.principal === request.principal &&
              grant.from === request.from &&
              grant.to === request.to &&
              grant.operations.includes("receive")
          ),
        principalForRecipient,
        resolveLocator,
        routePath: a2aConfig.routePath,
        sessionTtlMs: a2aConfig.sessionTtlMs,
        supervisorIds: supervisors.map((entry) => entry.supervisorId),
      },
      card: {
        description:
          "Authenticated Loop supervisor A2A V2 ingress. Provider acceptance is distinct from recipient consumption.",
        supervisorId: primarySupervisorId,
        url: `http://${input.config.hostname}:${input.config.port}${a2aConfig.routePath}`,
      },
      databaseUrl,
      ...(connectLeases
        ? {
            dependencies: {
              ...defaultSupervisorA2AV2ServiceDependencies,
              connectLeases,
            },
          }
        : {}),
      peerRoutes: legacyPeers.map((entry) => ({
        pathname: `${a2aConfig.routePath}/seats/${entry.seat}`,
        supervisorId: entry.supervisorId,
      })),
      assignmentRoute: {
        pathname: `${a2aConfig.routePath}/assignment`,
        principal: a2aConfig.principal,
      },
      resultGraphKey: resultGraphKeys.find((entry) => entry.role === "primary")
        ?.key,
      previousResultGraphKeys: resultGraphKeys
        .filter((entry) => entry.role === "previous")
        .map((entry) => entry.key),
      resultGraphRoute: {
        pathname: `${a2aConfig.routePath}/result-graph`,
        principal: a2aConfig.principal,
      },
      // The same operator-configured entries name the graph tasks this host's
      // tenant may bind results to.
      resultGraphTasks: a2aConfig.resultArtifacts?.map((entry) => ({
        graphWorkflowId: entry.graphWorkflowId,
        graphTaskId: entry.graphTaskId,
      })),
      verifyResultArtifact: a2aConfig.resultArtifacts
        ? createGitResultArtifactVerifier(a2aConfig.resultArtifacts)
        : undefined,
      delivery: new SupervisorMessageV2BridgeDeliveryPort(delivery),
      dispatchOwner: `v2-dispatcher:${a2aV2IdentityToken(input.config.identity)}`,
      readinessOutageBoundMs: a2aConfig.readinessOutageBoundMs,
      workflowIdFormat: a2aConfig.workflowIdFormat,
      notEnrolledBoundMs: a2aConfig.notEnrolledBoundMs,
      // Read lazily: the enrollments exist once enrollSessions has run, which
      // is before the host's first recovery sweep delivers anything.
      recipientEnrollment: {
        notEnrolled: () =>
          [
            ...new Set([
              ...(r8Enrollment?.notEnrolled() ?? []),
              ...(leaseEnrollment?.notEnrolled() ?? []),
            ]),
          ].sort(),
        notEnrolledSince: (id) =>
          r8Enrollment?.notEnrolledSince(id) ??
          leaseEnrollment?.notEnrolledSince(id),
      },
      // Enroll before the host's first recovery sweep checks readiness for
      // pending deliveries: a descriptor that expired, or a seat that restarted,
      // while the server was down is renewed or rebound first instead of
      // refusing start on every restart. No seat's failure refuses start
      // (fix8), the configured recipient's included: each failed seat is
      // reported as not enrolled and retried by the sweep, which afterwards
      // keeps every seat current. r9: the same pass, and the same sweep, keep
      // every live endpoint lease current.
      enrollSessions: async (sessions) => {
        const leases = sessions.endpointLeases;
        endpointLeaseReader ??= leases;
        if (recipient) {
          r8Enrollment = new ConfiguredA2AV2SessionEnrollment({
            config: a2aConfig,
            directory: input.directory,
            ...(leases
              ? {
                  leaseHeld: async (id: string) =>
                    (await leases.resolve(a2aConfig.tenant, id)).state !==
                    "none",
                }
              : {}),
            now: () => new Date().toISOString(),
            recipients: legacySeats,
            service: sessions,
          });
        }
        if (leases) {
          leaseEnrollment = new SupervisorEndpointLeaseEnrollment({
            leases,
            log: (line) => console.error(line),
            now: () => new Date().toISOString(),
            observe: createSupervisorEndpointLeaseObserver({
              // The lease's own endpoint check (descriptor identity, a fresh
              // locator resolution, the kind's no-turn probe), not delivery
              // routing: routing reports an expired lease "deferred", which
              // would keep an expired lease whose session is back from ever
              // being renewed (a server down longer than the TTL).
              probe: async (lease: SupervisorEndpointLeaseV2) =>
                (await checkSupervisorEndpointLease({
                  adapters: endpointAdapters,
                  descriptor: await sessions.currentSession(
                    { principal: lease.principal, tenantId: lease.tenantId },
                    lease.recipient
                  ),
                  lease,
                  resolveLocator,
                })) === "ready",
              resolveLocator,
            }),
            principalForRecipient,
            sessionTtlMs: a2aConfig.sessionTtlMs,
            tenant: a2aConfig.tenant,
          });
        }
        // maintain() reports every seat's failure as an outcome; the sweep
        // logs and retries it.
        a2aV2StartOutcomes = [
          ...((await r8Enrollment?.maintain()) ?? []),
          ...((await leaseEnrollment?.maintain()) ?? []),
        ];
      },
      host: hostOptions,
      messageAuthority: {
        decide: (request) => {
          const allowed =
            request.claimant === request.to &&
            input.config.grants.some(
              (grant) =>
                grant.principal === request.principal &&
                grant.from === request.from &&
                grant.to === request.to &&
                grant.operations.includes(request.operation)
            );
          return {
            allowed,
            authorityRef: `authority:${a2aV2IdentityToken(input.config.identity)}:recipient-v2`,
            reasonCode: allowed ? "configured-grant" : "grant-denied",
          };
        },
      },
      now: () => new Date().toISOString(),
      // Named in the quarantine commands a refused or quarantined recovery
      // record prints, so the operator can run them as shown.
      operatorConfigPath: input.configPath,
      policy: a2aConfig.policy,
      providerReadiness: new LoopCodexSessionV2ProviderReadiness({
        directory: input.directory,
        endpoints: endpointDescriptorReadiness,
      }),
      rebindAuthority: configuredA2AV2RebindAuthority(
        a2aConfig,
        legacySeats,
        principalForRecipient
      ),
      recipientRoute: {
        authenticator: controlAuthenticator,
        pathname: `${a2aConfig.routePath}/recipient`,
        principalForRecipient,
      },
      route: {
        authenticator: a2aAuthenticator(controlAuthenticator, a2aConfig),
        mounted: recipient !== undefined,
        pathname: a2aConfig.routePath,
        tenant: a2aConfig.tenant,
      },
      supervisorId: primarySupervisorId,
    });
    const enrollments = [r8Enrollment, leaseEnrollment].filter(
      (entry) => entry !== undefined
    );
    return {
      ...(enrollments.length > 0
        ? {
            a2aV2Enrollment: {
              maintain: async () => {
                const outcomes: A2AV2EnrollmentOutcome[] = [];
                for (const enrollment of enrollments) {
                  outcomes.push(...(await enrollment.maintain()));
                }
                return outcomes;
              },
            },
          }
        : {}),
      a2aV2Service,
      a2aV2StartOutcomes,
      host: a2aV2Service.host,
    };
  } catch (error) {
    // Stage and category, or an operator-actionable refusal (a workflow id
    // format or recovery refusal naming its quarantine command); never a
    // connection string.
    return { ...(await v1Only()), a2aV2StartFailure: failureMessage(error) };
  }
};

const validateConfiguredRuntimeEnvironment = (
  config: ServerConfig,
  env: NodeJS.ProcessEnv,
  options: LoopOrchestrationServerOptions
): void => {
  if (config.a2aV2 && options.a2aV2Service) {
    throw new Error("configured A2A V2 cannot use an injected service");
  }
  for (const supervisor of config.supervisors) {
    if (!env[supervisor.tokenEnv]) {
      throw new Error(
        `missing orchestration token environment ${supervisor.tokenEnv}`
      );
    }
  }
  // fix8: nothing about A2A V2 refuses start here. Its database variable and
  // result graph keys are decideA2AV2Plane's: a problem there disables V2.
};

/**
 * fix8: the config identity as it may appear in a V2 dispatch owner
 * (`v2-dispatcher:<token>`) and authority reference
 * (`authority:<token>:recipient-v2`), which allow [A-Za-z0-9._:-] only. The
 * config allows `@`, and the live identity is `loop-orchestration@<host>`:
 * used verbatim it refused every V2 start ("dispatch owner is invalid"). Any
 * other character becomes `-`; an identity already valid is unchanged.
 */
export const a2aV2IdentityToken = (identity: string): string =>
  identity.replace(V2_REFERENCE_INVALID_RE, "-");

/** Whether the configured A2A V2 plane is mounted; see `a2aV2State`. */
export type A2AV2PlaneState = "disabled" | "off" | "ready";

/**
 * fix8: why a configured A2A V2 plane is disabled; /healthz `a2aV2Reason`
 * and the one `A2A V2 disabled (<reason>): ...` line.
 * - `config-invalid`: the a2aV2 section fails validation (V1's part is
 *   valid; an invalid V1 part still refuses start).
 * - `env-file-mode`: `a2a-v2.env` is group- or world-readable; not read.
 * - `env-file-unreadable`: `a2a-v2.env` is a symlink, not a regular file,
 *   not openable or malformed.
 * - `result-graph-key`: a configured result graph key variable is unset,
 *   shorter than 32 bytes, or holds the same key as another.
 * - `database-unset`: the ledger database variable is unset.
 * - `database-unreachable`: the ledger does not answer within the bound.
 * - `start-failed`: the V2 service did not start (a store, migration,
 *   recovery or workflow id format refusal); the line carries its message.
 */
export type A2AV2DisabledReason =
  | "config-invalid"
  | "database-unreachable"
  | "database-unset"
  | A2AV2EnvFileRefusalCode
  | "result-graph-key"
  | "start-failed";

export interface A2AV2PlaneStatus {
  reason?: A2AV2DisabledReason;
  state: A2AV2PlaneState;
}

/** The one line a disabled V2 plane logs. Names, paths and codes only. */
export const a2aV2DisabledLine = (
  reason: A2AV2DisabledReason,
  detail: string
): string => `A2A V2 disabled (${reason}): ${detail}; V1 continues`;

/**
 * The serve-time parse: an invalid V1 part refuses start (it throws, as
 * `parseLoopOrchestrationConfig` does), while an invalid a2aV2 section is
 * returned as `sectionError` beside the V1-only config, for
 * `decideA2AV2Plane` to disable V2 with. `a2a-v2 init` and the operator
 * commands keep the strict parser.
 */
export const parseLoopOrchestrationServeConfig = (
  value: unknown
): { config: ServerConfig; sectionError?: string } => {
  if (!isRecord(value) || value.a2aV2 === undefined) {
    return { config: parseLoopOrchestrationConfig(value) };
  }
  const { a2aV2: _section, ...v1Value } = value;
  const v1Config = parseLoopOrchestrationConfig(v1Value);
  try {
    return { config: parseLoopOrchestrationConfig(value) };
  } catch (error) {
    return { config: v1Config, sectionError: failureMessage(error) };
  }
};

/**
 * fix8: V2 is on whenever the config has a valid a2aV2 section, and never at
 * the price of V1. No section: one line naming `a2a-v2 init`. Any problem
 * with a section (see `A2AV2DisabledReason`): one `A2A V2 disabled
 * (<reason>): ...` line, and the server starts V1 alone. Lines name
 * variables, paths and fixes, never a URL or a secret.
 */
export const decideA2AV2Plane = async (input: {
  config: ServerConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  /** Why `a2a-v2.env` was not read, when it was not (loadA2AV2EnvFile). */
  envFileRefusal?: A2AV2EnvFileRefusal;
  log: (line: string) => void;
  probe?: (databaseUrl: string) => Promise<boolean>;
  /** The a2aV2 section's validation error (parseLoopOrchestrationServeConfig). */
  sectionError?: string;
}): Promise<{ config: ServerConfig } & A2AV2PlaneStatus> => {
  const { a2aV2: _section, ...v1Only } = input.config;
  const disabled = (reason: A2AV2DisabledReason, detail: string) => {
    input.log(a2aV2DisabledLine(reason, detail));
    return { config: v1Only, reason, state: "disabled" as const };
  };
  if (input.sectionError !== undefined) {
    return disabled(
      "config-invalid",
      `the a2aV2 section of ${input.configPath} is invalid (${input.sectionError}). Fix or remove the section, then restart`
    );
  }
  const a2aConfig = input.config.a2aV2;
  if (!a2aConfig) {
    input.log(
      `A2A V2 off: run loop orchestration a2a-v2 init ${input.configPath}${
        input.envFileRefusal ? ` (note: ${input.envFileRefusal.reason})` : ""
      }`
    );
    return { config: input.config, state: "off" };
  }
  if (input.envFileRefusal) {
    return disabled(input.envFileRefusal.code, input.envFileRefusal.reason);
  }
  try {
    resolveResultGraphKeys(a2aConfig, input.env);
  } catch (error) {
    return disabled(
      "result-graph-key",
      `${failureMessage(error)}. Set it (in the environment or ${a2aV2EnvFilePath(input.configPath)}), then restart`
    );
  }
  const databaseUrl = input.env[a2aConfig.databaseUrlEnv];
  if (!databaseUrl) {
    return disabled(
      "database-unset",
      `ledger database variable ${a2aConfig.databaseUrlEnv} is not set (neither in the environment nor in ${a2aV2EnvFilePath(input.configPath)})`
    );
  }
  if (!(await (input.probe ?? probeA2AV2Database)(databaseUrl))) {
    return disabled(
      "database-unreachable",
      `the ledger database named by ${a2aConfig.databaseUrlEnv} is unreachable. Restart the service once it answers`
    );
  }
  return { config: input.config, state: "ready" };
};

/**
 * The operator tool behind `loop orchestration result-graph-key-fingerprints`:
 * each configured result graph key's fingerprint, by the variable holding it
 * and its role. A refusal or report naming a fingerprint is matched to a key
 * this way; the key itself is never printed.
 */
export const resultGraphKeyFingerprintsForConfig = (
  configPath: string,
  env: NodeJS.ProcessEnv = process.env
): { env: string; fingerprint: string; role: "previous" | "primary" }[] => {
  const config = parseLoopOrchestrationConfig(readConfigFile(configPath));
  if (!config.a2aV2) {
    throw new Error("orchestration config has no a2aV2 route");
  }
  const keys = resolveResultGraphKeys(
    config.a2aV2,
    withA2AV2EnvFile(configPath, env)
  );
  if (keys.length === 0) {
    throw new Error("orchestration a2aV2 has no resultGraphKeyEnv");
  }
  return keys.map((entry) => ({
    env: entry.env,
    fingerprint: entry.key.fingerprint,
    role: entry.role,
  }));
};

/**
 * The operator tool behind `loop orchestration result-graph-id`: the keyed
 * result graph id this config's server derives for one message of its route
 * tenant and control principal, for a `resultArtifacts` entry. It reads the
 * key from the configured environment variable and prints only the id.
 */
export const resultGraphWorkflowIdForConfig = (
  configPath: string,
  messageWorkflowId: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const config = parseLoopOrchestrationConfig(readConfigFile(configPath));
  if (!config.a2aV2) {
    throw new Error("orchestration config has no a2aV2 route");
  }
  const key = resolveResultGraphKey(
    config.a2aV2,
    withA2AV2EnvFile(configPath, env)
  );
  if (!key) {
    throw new Error("orchestration a2aV2 has no resultGraphKeyEnv");
  }
  return deriveSupervisorMessageV2ResultGraphWorkflowId(
    key,
    { principal: config.a2aV2.principal, tenantId: config.a2aV2.tenant },
    messageWorkflowId
  );
};

/** One operator request against the configured deployment's recovery. */
export type RecoveryQuarantineRequest =
  | {
      by: string;
      command: "v2-quarantine" | "v2-quarantine-release";
      reason: string;
      workflowId: string;
    }
  | { command: "v2-quarantine-list" };

const quarantineText = (entry: SupervisorMessageV2RecoveryQuarantineEntry) =>
  `${entry.workflowId} for ${entry.recipient} by ${entry.by} at ${entry.at}: ${entry.reason}`;

/**
 * The operator tool behind `loop orchestration v2-quarantine`,
 * `v2-quarantine-release` and `v2-quarantine-list`: the explicit, durable
 * escape from a recorded start that refuses every service start. It opens
 * the ledger of this config's deployment (its task queue) with the database
 * URL from the configured environment variable, applies the server's own
 * additive migrations, and returns the lines to print: workflow ids,
 * recipient, who, when and why, never the database URL.
 */
export const recoveryQuarantineForConfig = async (
  configPath: string,
  request: RecoveryQuarantineRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> => {
  const config = parseLoopOrchestrationConfig(readConfigFile(configPath));
  if (!config.a2aV2) {
    throw new Error("orchestration config has no a2aV2 route");
  }
  const databaseUrl = withA2AV2EnvFile(configPath, env)[
    config.a2aV2.databaseUrlEnv
  ];
  if (!databaseUrl) {
    throw new Error(
      `missing orchestration A2A V2 database environment ${config.a2aV2.databaseUrlEnv}`
    );
  }
  let ledger: PostgresSupervisorMessageV2DeliveryLedger | undefined;
  try {
    // Opened as the server opens it: the same build, deployment and
    // workflow id format, so its migration records and enforces exactly
    // what the server's next start would.
    ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      {
        buildId: config.buildId,
        deployment: config.taskQueue,
        ...(config.a2aV2.workflowIdFormat
          ? { workflowIdFormat: config.a2aV2.workflowIdFormat }
          : {}),
      }
    );
    await ledger.migrate();
  } catch (error) {
    await ledger?.close().catch(() => undefined);
    // A refusal over the ledger's workflow id format is the operator's to
    // act on, and its message names formats, builds and counts only.
    if (error instanceof SupervisorMessageV2WorkflowIdFormatError) {
      throw new Error(`orchestration A2A V2 ledger refused: ${error.message}`);
    }
    // A driver error may carry connection details; report none of them.
    throw new Error("orchestration A2A V2 ledger is unavailable");
  }
  try {
    if (request.command === "v2-quarantine-list") {
      const entries = await ledger.recoveryQuarantines();
      return entries.length === 0
        ? ["no quarantined V2 recovery records"]
        : entries.map(
            (entry) =>
              `${entry.workflowId} for ${entry.recipient} quarantined by ${entry.by} at ${entry.at}: ${entry.reason}`
          );
    }
    const note = { by: request.by, reason: request.reason };
    if (request.command === "v2-quarantine-release") {
      const released = await ledger.releaseRecoveryQuarantine(
        request.workflowId,
        note
      );
      return [
        `released ${released.workflowId} for ${released.recipient} (quarantined by ${released.by} at ${released.at}: ${released.reason})`,
      ];
    }
    const { created, quarantine } = await ledger.quarantineRecovery(
      request.workflowId,
      note
    );
    return [
      `${created ? "quarantined" : "already quarantined"} ${quarantineText(quarantine)}`,
    ];
  } finally {
    await ledger.close();
  }
};

/**
 * fix8: the start-time configuration. Only V1's part of it may refuse start
 * (an invalid V1 config, a missing V1 token). Everything about A2A V2 (the
 * env file, the section, its keys and ledger) decides the plane instead.
 */
const startConfiguration = async (
  configPath: string,
  inputEnv: NodeJS.ProcessEnv,
  options: LoopOrchestrationServerOptions,
  log: (line: string) => void
): Promise<{
  env: NodeJS.ProcessEnv;
  plane: { config: ServerConfig } & A2AV2PlaneStatus;
  /** The configured a2aV2.routePath, when the section parsed. */
  routePath?: string;
}> => {
  // The secrets `a2a-v2 init` wrote next to the config, under whatever the
  // process environment already sets. A refused file is not read.
  const loaded = loadA2AV2EnvFile(configPath, inputEnv);
  const { config: parsed, sectionError } = parseLoopOrchestrationServeConfig(
    readConfigFile(configPath)
  );
  validateConfiguredRuntimeEnvironment(parsed, loaded.env, options);
  if (options.a2aV2Service) {
    return { env: loaded.env, plane: { config: parsed, state: "ready" } };
  }
  return {
    env: loaded.env,
    ...(parsed.a2aV2 ? { routePath: parsed.a2aV2.routePath } : {}),
    plane: await decideA2AV2Plane({
      config: parsed,
      configPath,
      env: loaded.env,
      ...(loaded.refusal ? { envFileRefusal: loaded.refusal } : {}),
      log,
      ...(options.probeA2AV2Database
        ? { probe: options.probeA2AV2Database }
        : {}),
      ...(sectionError === undefined ? {} : { sectionError }),
    }),
  };
};

export const runLoopOrchestrationServer = async (
  configPath: string,
  inputEnv: NodeJS.ProcessEnv = process.env,
  options: LoopOrchestrationServerOptions = {}
): Promise<void> => {
  const log = (line: string) => console.error(line);
  const start = await startConfiguration(configPath, inputEnv, options, log);
  const env = start.env;
  let plane = start.plane;
  const config = plane.config;
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const directory = new LoopSupervisorDirectory(config.supervisors);
  const mailboxes = new Map(
    config.supervisors.flatMap((entry) =>
      entry.mailbox ? [[entry.supervisorId, entry.mailbox] as const] : []
    )
  );
  let connection: Connection | undefined;
  let nativeConnection: NativeConnection | undefined;
  let host: TemporalSupervisorRuntimeHost | undefined;
  let deadlineTimer: ReturnType<typeof setInterval> | undefined;
  let wakeTimer: ReturnType<typeof setInterval> | undefined;
  let a2aV2Service = options.a2aV2Service;
  let a2aV2Enrollment:
    | Pick<ConfiguredA2AV2SessionEnrollment, "maintain">
    | undefined;
  let a2aV2StartOutcomes: readonly A2AV2EnrollmentOutcome[] | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciliationHealthy = false;
  let notEnrolled: readonly string[] = [];
  try {
    if (a2aV2Service) {
      host = a2aV2Service.host;
    } else {
      connection = await Connection.connect({ address: config.address });
      nativeConnection = await NativeConnection.connect({
        address: config.address,
      });
      const created = await createDefaultRuntimeHost({
        config,
        configPath,
        connection,
        directory,
        endpointRoots:
          options.a2aV2EndpointRoots ?? supervisorEndpointRoots(homedir()),
        endpoints: options.a2aV2Endpoints ?? defaultA2AV2EndpointFactories,
        env,
        mailboxes,
        nativeConnection,
      });
      a2aV2Enrollment = created.a2aV2Enrollment;
      a2aV2StartOutcomes = created.a2aV2StartOutcomes;
      a2aV2Service = created.a2aV2Service;
      host = created.host;
      if (created.a2aV2StartFailure !== undefined) {
        log(
          a2aV2DisabledLine(
            "start-failed",
            `${created.a2aV2StartFailure}. Fix the cause, then restart`
          )
        );
        const { a2aV2: _section, ...v1Config } = plane.config;
        plane = { config: v1Config, reason: "start-failed", state: "disabled" };
      }
    }
    // Authority of record for a tick, keyed by the exact message pair.
    const tickPrincipals = new Map(
      config.grants.flatMap((grant) =>
        grant.operations.includes("tick")
          ? [[`${grant.from}\n${grant.to}`, grant.principal] as const]
          : []
      )
    );
    const reconciler = new SupervisorBridgeConsumptionReconciler({
      bindings: config.supervisors,
      directory,
      runtime: host.runtime,
    });
    // A mailbox recipient has no pane, so the bridge reconciler skips it and
    // its own acknowledgment would never reach the workflow. This carries it.
    const mailboxReconciler = new SupervisorMailboxConsumptionReconciler({
      bindings: config.supervisors.flatMap((entry) =>
        entry.mailbox
          ? [
              {
                mailbox: entry.mailbox,
                principal: entry.principal,
                supervisorId: entry.supervisorId,
              },
            ]
          : []
      ),
      log: (line) => console.error(line),
      runtime: host.runtime,
    });
    const reconcile = createOrchestrationSweep({
      enrollment: a2aV2Enrollment,
      log: (line) => console.error(line),
      reconcilers: [reconciler, mailboxReconciler],
      setHealthy: (healthy) => {
        reconciliationHealthy = healthy;
      },
      setNotEnrolled: (seats) => {
        notEnrolled = seats;
      },
      startOutcomes: a2aV2StartOutcomes,
    });
    await reconcile();
    if (config.deadlines) {
      const driver = new SupervisorDeadlineDriver({
        board: () =>
          host?.runtime
            .threads()
            .threads.flatMap((thread) =>
              thread.messages.map((message) => message.item)
            ) ?? [],
        log: (line) => console.error(line),
        principalFor: (item) => tickPrincipals.get(`${item.from}\n${item.to}`),
        tick: (input) =>
          (host as TemporalSupervisorRuntimeHost).runtime.tick({
            principal: input.principal,
            requestId: input.requestId,
            workflowId: input.workflowId,
          }),
      });
      deadlineTimer = setInterval(() => {
        driver.sweep().catch((error) => {
          console.error(
            `orchestration deadline sweep failed: ${error instanceof Error ? error.message : "unknown error"}`
          );
        });
      }, config.deadlines.intervalMs);
    }
    if (config.wake) {
      // Only recipients that declared a session can be woken. One with a
      // mailbox and no wakeSession is reported once and then left alone: it is
      // reachable by delivery but has no supported wake on this host, and
      // guessing a session name would notify the wrong one.
      const targets = config.supervisors.flatMap((entry) =>
        entry.mailbox && entry.wakeSession
          ? [
              {
                mailbox: entry.mailbox,
                recipient: entry.supervisorId,
                sessionName: entry.wakeSession,
              },
            ]
          : []
      );
      for (const entry of config.supervisors) {
        if (entry.mailbox && !entry.wakeSession) {
          console.error(
            `[loop] ${entry.supervisorId} has a mailbox but no wakeSession: delivery only, no wake`
          );
        }
      }
      const wakeDriver = new SupervisorWakeDriver({
        log: (line) => console.error(line),
        port: new HeadlessClaudeWakePort({
          log: (line) => console.error(line),
          run: spawnHeadless,
        }),
        targets,
      });
      wakeTimer = setInterval(() => {
        wakeDriver.sweep().catch((error) => {
          console.error(
            `orchestration wake sweep failed: ${error instanceof Error ? error.message : "unknown error"}`
          );
        });
      }, config.wake.intervalMs);
    }
    // Debug only (LOOP_A2A_V2_TIMING=1); otherwise every wrap is identity.
    const timing = a2aV2TimingProbe(env);
    const timedReconcile = timing.pass("reconcile pass", reconcile);
    reconcileTimer = setInterval(() => {
      timedReconcile().catch((error) => {
        reconciliationHealthy = false;
        console.error(
          `orchestration bridge reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      });
    }, 250);
    const untimedHandler = createLoopOrchestrationFetchHandler({
      // A configured plane that is disabled answers 503 on its own routes.
      a2aV2DisabledRoutePath: () =>
        plane.state === "disabled" ? start.routePath : undefined,
      a2aV2Service,
      a2aV2State: () => ({
        state: plane.state,
        ...(plane.reason ? { reason: plane.reason } : {}),
      }),
      authenticator: authenticator(config, env),
      host,
      notEnrolledSeats: () => notEnrolled,
      reconciliationHealthy: () => reconciliationHealthy,
    });
    const handler = timing.handler(untimedHandler);
    const server = serve({
      fetch: handler,
      hostname: config.hostname,
      port: config.port,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
        timing.stop();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        options.signal?.removeEventListener("abort", stop);
        server.stop(true);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (options.signal?.aborted) {
        stop();
      } else {
        options.signal?.addEventListener("abort", stop, { once: true });
      }
    });
  } finally {
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
    }
    if (deadlineTimer) {
      clearInterval(deadlineTimer);
    }
    if (wakeTimer) {
      clearInterval(wakeTimer);
    }
    if (a2aV2Service) {
      await a2aV2Service.close();
    } else {
      await host?.close();
    }
    await nativeConnection?.close();
    await connection?.close();
  }
};

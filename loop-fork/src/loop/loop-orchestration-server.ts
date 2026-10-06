import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { serve } from "bun";
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
import {
  createSupervisorA2AV2Service,
  type SupervisorA2AV2Service,
} from "./supervisor-a2a-v2-service";
import { SupervisorBridgeConsumptionReconciler } from "./supervisor-bridge-consumption";
import { SupervisorDeadlineDriver } from "./supervisor-deadline-driver";
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
  SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS,
  type SupervisorMessageV2WorkflowIdFormat,
} from "./supervisor-message-v2-delivery-ledger";
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
 * `governess-beat:<runId>`, whose history is the governess journal.
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
  principal: string;
  /**
   * How long a session readiness-store outage may defer a recipient's V2
   * deliveries (1000..86400000 ms) before each delivery fails as a normal
   * retryable attempt. Omitted, the runtime default of 15 minutes.
   */
  readinessOutageBoundMs?: number;
  recipient: string;
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
export interface LoopOrchestrationServerOptions {
  a2aV2Service?: SupervisorA2AV2Service;
  /**
   * Stops the server as SIGINT or SIGTERM would, for an embedding caller or a
   * test driving the whole composition. The signals still stop it.
   */
  signal?: AbortSignal;
}

export interface LoopOrchestrationFetchHandlerOptions {
  a2aV2Service?: Pick<
    SupervisorA2AV2Service,
    | "httpHandler"
    | "notEnrolledDeferral"
    | "pathname"
    | "pathnames"
    | "readinessOutage"
    | "recipientRoute"
    | "assignmentRoute"
    | "resultGraphRoute"
  >;
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
      `${label} uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId naming the one graph task this artifact is evidence for (graphWorkflowId is the message-derived result graph, supervisor-result-graph:v3:<hmac-sha256>, from \`loop orchestration result-graph-id\`)`
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
      "recipient",
      "routePath",
      "sessionTtlMs",
      "tenant",
      ...(value.resultArtifacts === undefined ? [] : ["resultArtifacts"]),
      ...(value.resultGraphKeyEnv === undefined ? [] : ["resultGraphKeyEnv"]),
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
  const recipient = required(
    value.recipient,
    SUPERVISOR_RE,
    "orchestration a2aV2 recipient"
  );
  const recipientBinding = supervisors.find(
    (supervisor) => supervisor.supervisorId === recipient
  );
  if (!supervisors.some((supervisor) => supervisor.principal === principal)) {
    throw new Error("orchestration a2aV2 principal is not configured");
  }
  if (!recipientBinding?.manifestPath) {
    throw new Error("orchestration a2aV2 recipient is not a Loop binding");
  }
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
    throw new Error(
      "orchestration a2aV2 resultArtifacts requires resultGraphKeyEnv: name the environment variable holding the host's result graph HMAC key (at least 32 bytes), then compute each graphWorkflowId with `loop orchestration result-graph-id <config-path> <message-workflow-id>`"
    );
  }
  return {
    ...(resultGraphKeyEnv ? { resultGraphKeyEnv } : {}),
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
    recipient,
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
const resolveResultGraphKey = (
  config: A2AV2Config,
  env: NodeJS.ProcessEnv
): SupervisorResultGraphKey | undefined => {
  if (!config.resultGraphKeyEnv) {
    return undefined;
  }
  const secret = env[config.resultGraphKeyEnv];
  if (!secret) {
    throw new Error(
      `missing orchestration A2A V2 result graph key environment ${config.resultGraphKeyEnv}`
    );
  }
  try {
    return SupervisorResultGraphKey.fromSecret(secret);
  } catch {
    throw new Error(
      `orchestration A2A V2 result graph key environment ${config.resultGraphKeyEnv} must hold at least 32 bytes`
    );
  }
};

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

interface A2AV2EnrollmentInput {
  config: A2AV2Config;
  directory: SupervisorBridgeDirectory;
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
 * session is absent from the run. Only this class lets a peer seat be
 * degraded at start; every other failure (an authority denial, an identity
 * or registration conflict, a store or configuration error) refuses start.
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
  | { recipient: string; state: "deferred" | "enrolled" | "unchanged" }
  | { error: unknown; recipient: string; state: "failed" };

/**
 * Start-time verdict on the first `maintain()` pass. The configured
 * recipient's own failure refuses start, with its own cause. A peer seat that
 * is not running or not reachable (`A2AV2SeatUnavailableError`) degrades that
 * seat alone: the server starts, the sweep reports the peer as not enrolled (a
 * log line, a count on /healthz, the seat id on the authenticated assignment
 * status) and retries it. Any other peer failure (an authority denial, an
 * identity or registration conflict, a store error) refuses start with the
 * peer's own cause. While a recipient is not enrolled, its deliveries wait
 * without spending attempts up to the not-enrolled bound (see
 * `SupervisorMessageV2NotEnrolledDeferral`), then fail as normal retryable
 * attempts.
 */
export const requireA2AV2Enrollment = (
  outcomes: readonly A2AV2EnrollmentOutcome[],
  recipient: string
): void => {
  for (const outcome of outcomes) {
    if (
      outcome.state === "failed" &&
      (outcome.recipient === recipient ||
        !(outcome.error instanceof A2AV2SeatUnavailableError))
    ) {
      throw outcome.error;
    }
  }
};

/**
 * Keeps every configured seat's descriptor current for the life of the
 * server, not only at start: it renews before expiry and rebinds when a Codex
 * thread or Claude session restarts. It owns no timer; the server's existing
 * reconciliation sweep calls `maintain()`. Between writes it compares the
 * seat's bridge status with the descriptor it last enrolled, so a quiet sweep
 * reads local files only. A failed seat is retried after a short delay, and
 * is reported as `deferred` (not as a success) until then.
 */
export class ConfiguredA2AV2SessionEnrollment {
  readonly #enrolled = new Map<string, SupervisorSessionDescriptorV2>();
  readonly #input: A2AV2EnrollmentInput;
  /** When each failing seat's current failure began (epoch ms). */
  readonly #notEnrolledSince = new Map<string, number>();
  readonly #recipients: readonly string[];
  readonly #retryAt = new Map<string, number>();

  constructor(input: A2AV2EnrollmentInput & { recipients: readonly string[] }) {
    const { recipients, ...enrollment } = input;
    this.#input = enrollment;
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

export const configuredA2AV2RebindAuthority = (
  config: A2AV2Config,
  recipients: readonly string[] = [config.recipient]
) => ({
  decide(input: {
    current: SupervisorSessionDescriptorV2;
    next: SupervisorSessionDescriptorV2;
    trustedScope: { principal: string; tenantId: string };
  }) {
    const allowed =
      input.trustedScope.principal === config.principal &&
      input.trustedScope.tenantId === config.tenant &&
      recipients.includes(input.current.recipient) &&
      input.next.recipient === input.current.recipient &&
      input.current.descriptorId === input.next.descriptorId &&
      input.next.provider === input.current.provider &&
      input.next.endpointRef === config.endpointRef;
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
  connection: Connection;
  directory: LoopSupervisorDirectory;
  env: NodeJS.ProcessEnv;
  mailboxes: ReadonlyMap<string, string>;
  nativeConnection: NativeConnection;
}): Promise<{
  a2aV2Enrollment?: ConfiguredA2AV2SessionEnrollment;
  a2aV2Service: SupervisorA2AV2Service | undefined;
  a2aV2StartOutcomes?: readonly A2AV2EnrollmentOutcome[];
  host: TemporalSupervisorRuntimeHost;
}> => {
  const delivery = new FirstAvailableDeliveryPort([
    new BridgeSupervisorMessageDeliveryPort({ directory: input.directory }),
    new MailboxSupervisorMessageDeliveryPort({
      directory: { resolveMailbox: (id) => input.mailboxes.get(id) },
    }),
  ]);
  const hostOptions = {
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
  };
  if (!input.config.a2aV2) {
    return {
      a2aV2Service: undefined,
      host: await TemporalSupervisorRuntimeHost.create(hostOptions),
    };
  }
  const a2aConfig = input.config.a2aV2;
  const databaseUrl = input.env[a2aConfig.databaseUrlEnv];
  if (!databaseUrl) {
    throw new Error("configured A2A V2 database environment is absent");
  }
  const controlAuthenticator = authenticator(input.config, input.env);
  const recipientBinding = input.config.supervisors.find(
    (entry) => entry.supervisorId === a2aConfig.recipient
  );
  let a2aV2Enrollment: ConfiguredA2AV2SessionEnrollment | undefined;
  let a2aV2StartOutcomes: readonly A2AV2EnrollmentOutcome[] | undefined;
  let enrollmentFailure: { error: unknown } | undefined;
  const a2aV2Service = await createSupervisorA2AV2Service({
    card: {
      description:
        "Authenticated Loop supervisor A2A V2 ingress. Provider acceptance is distinct from recipient consumption.",
      supervisorId: a2aConfig.recipient,
      url: `http://${input.config.hostname}:${input.config.port}${a2aConfig.routePath}`,
    },
    databaseUrl,
    peerRoutes: input.config.supervisors
      .filter(
        (entry) =>
          entry.seat &&
          entry.supervisorId !== a2aConfig.recipient &&
          entry.manifestPath ===
            input.config.supervisors.find(
              (recipient) => recipient.supervisorId === a2aConfig.recipient
            )?.manifestPath
      )
      .map((entry) => ({
        pathname: `${a2aConfig.routePath}/seats/${entry.seat}`,
        supervisorId: entry.supervisorId,
      })),
    assignmentRoute: {
      pathname: `${a2aConfig.routePath}/assignment`,
      principal: a2aConfig.principal,
    },
    resultGraphKey: resolveResultGraphKey(a2aConfig, input.env),
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
    dispatchOwner: `v2-dispatcher:${input.config.identity}`,
    readinessOutageBoundMs: a2aConfig.readinessOutageBoundMs,
    workflowIdFormat: a2aConfig.workflowIdFormat,
    notEnrolledBoundMs: a2aConfig.notEnrolledBoundMs,
    // Read lazily: the enrollment exists once enrollSessions has run, which
    // is before the host's first recovery sweep delivers anything.
    recipientEnrollment: {
      notEnrolled: () => a2aV2Enrollment?.notEnrolled() ?? [],
      notEnrolledSince: (recipient) =>
        a2aV2Enrollment?.notEnrolledSince(recipient),
    },
    // Enroll before the host's first recovery sweep checks readiness for
    // pending deliveries: a descriptor that expired, or a seat that restarted,
    // while the server was down is renewed or rebound first instead of
    // refusing start on every restart. Start still refuses when the
    // configured recipient cannot be enrolled, and when a peer fails for any
    // reason but a seat that is not running; a stopped peer is degraded
    // alone: the sweep reports it as not enrolled and retries it. Afterwards
    // the sweep keeps every seat current.
    enrollSessions: async (sessions) => {
      a2aV2Enrollment = new ConfiguredA2AV2SessionEnrollment({
        config: a2aConfig,
        directory: input.directory,
        now: () => new Date().toISOString(),
        recipients: [
          a2aConfig.recipient,
          ...input.config.supervisors
            .filter(
              (peer) =>
                peer.seat &&
                peer.supervisorId !== a2aConfig.recipient &&
                peer.manifestPath === recipientBinding?.manifestPath
            )
            .map((peer) => peer.supervisorId),
        ],
        service: sessions,
      });
      try {
        a2aV2StartOutcomes = await a2aV2Enrollment.maintain();
        requireA2AV2Enrollment(a2aV2StartOutcomes, a2aConfig.recipient);
      } catch (error) {
        enrollmentFailure = { error };
        throw error;
      }
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
          authorityRef: `authority:${input.config.identity}:recipient-v2`,
          reasonCode: allowed ? "configured-grant" : "grant-denied",
        };
      },
    },
    now: () => new Date().toISOString(),
    policy: a2aConfig.policy,
    providerReadiness: new LoopCodexSessionV2ProviderReadiness({
      directory: input.directory,
    }),
    rebindAuthority: configuredA2AV2RebindAuthority(
      a2aConfig,
      input.config.supervisors
        .filter(
          (entry) =>
            entry.supervisorId === a2aConfig.recipient ||
            (entry.seat &&
              entry.manifestPath ===
                input.config.supervisors.find(
                  (recipient) => recipient.supervisorId === a2aConfig.recipient
                )?.manifestPath)
        )
        .map((entry) => entry.supervisorId)
    ),
    recipientRoute: {
      authenticator: controlAuthenticator,
      pathname: `${a2aConfig.routePath}/recipient`,
      principalForRecipient: (recipient) =>
        input.config.supervisors.find(
          (entry) => entry.supervisorId === recipient
        )?.principal,
    },
    route: {
      authenticator: a2aAuthenticator(controlAuthenticator, a2aConfig),
      pathname: a2aConfig.routePath,
      tenant: a2aConfig.tenant,
    },
    supervisorId: a2aConfig.recipient,
  }).catch((error: unknown) => {
    // The factory reports a stage, not the cause. An enrollment refusal is
    // the operator's to act on, so it keeps its own message, as before.
    throw enrollmentFailure ? enrollmentFailure.error : error;
  });
  return {
    a2aV2Enrollment,
    a2aV2Service,
    a2aV2StartOutcomes,
    host: a2aV2Service.host,
  };
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
  if (config.a2aV2 && !env[config.a2aV2.databaseUrlEnv]) {
    throw new Error(
      `missing orchestration A2A V2 database environment ${config.a2aV2.databaseUrlEnv}`
    );
  }
  if (config.a2aV2) {
    resolveResultGraphKey(config.a2aV2, env);
  }
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
  const key = resolveResultGraphKey(config.a2aV2, env);
  if (!key) {
    throw new Error("orchestration a2aV2 has no resultGraphKeyEnv");
  }
  return deriveSupervisorMessageV2ResultGraphWorkflowId(
    key,
    { principal: config.a2aV2.principal, tenantId: config.a2aV2.tenant },
    messageWorkflowId
  );
};

export const runLoopOrchestrationServer = async (
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LoopOrchestrationServerOptions = {}
): Promise<void> => {
  const config = parseLoopOrchestrationConfig(readConfigFile(configPath));
  validateConfiguredRuntimeEnvironment(config, env, options);
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
  let a2aV2Enrollment: ConfiguredA2AV2SessionEnrollment | undefined;
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
        connection,
        directory,
        env,
        mailboxes,
        nativeConnection,
      });
      a2aV2Enrollment = created.a2aV2Enrollment;
      a2aV2StartOutcomes = created.a2aV2StartOutcomes;
      a2aV2Service = created.a2aV2Service;
      host = created.host;
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
    reconcileTimer = setInterval(() => {
      reconcile().catch((error) => {
        reconciliationHealthy = false;
        console.error(
          `orchestration bridge reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      });
    }, 250);
    const handler = createLoopOrchestrationFetchHandler({
      a2aV2Service,
      authenticator: authenticator(config, env),
      host,
      notEnrolledSeats: () => notEnrolled,
      reconciliationHealthy: () => reconciliationHealthy,
    });
    const server = serve({
      fetch: handler,
      hostname: config.hostname,
      port: config.port,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
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

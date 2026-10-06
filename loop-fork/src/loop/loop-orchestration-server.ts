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
import { BridgeSupervisorMessageDeliveryPort } from "./bridge-supervisor-message-delivery";
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
import { SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE } from "./supervisor-message-v2-contract";
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

interface A2AV2Config {
  databaseUrlEnv: string;
  endpointRef: string;
  policy: {
    claimTimeoutMs: number;
    escalationTimeoutMs: number;
    maxDeliveryAttempts: number;
    retryDelayMs: number;
  };
  principal: string;
  recipient: string;
  resultArtifacts?: GitResultArtifactBinding[];
  routePath: string;
  sessionTtlMs: number;
  tenant: string;
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
}

export interface LoopOrchestrationFetchHandlerOptions {
  a2aV2Service?: Pick<
    SupervisorA2AV2Service,
    | "httpHandler"
    | "pathname"
    | "pathnames"
    | "recipientRoute"
    | "assignmentRoute"
  >;
  authenticator: SupervisorControlSurfaceAuthenticator;
  host: Pick<TemporalSupervisorRuntimeHost, "httpHandler" | "workerState">;
  reconciliationHealthy: () => boolean;
}

/**
 * The one HTTP mount point for the existing V1 control surface and an
 * explicitly supplied V2 A2A service. It does not construct either host and
 * therefore cannot create a competing worker, listener, or recovery owner.
 */
export const createLoopOrchestrationFetchHandler = (
  options: LoopOrchestrationFetchHandlerOptions
): ((request: Request) => Promise<Response>) => {
  const v1Handler = options.host.httpHandler(options.authenticator);
  return (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Promise.resolve(
        Response.json({
          schema: "loop-orchestration-health.v1",
          state:
            options.host.workerState() === "RUNNING" &&
            options.reconciliationHealthy()
              ? "ready"
              : "unavailable",
        })
      );
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
 * and the graph must be a message-derived result graph
 * (`deriveSupervisorMessageV2ResultGraphWorkflowId(scope, messageWorkflowId)`),
 * since no other graph can ever be bound.
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
      `${label} uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId naming the one graph task this artifact is evidence for (graphWorkflowId is the message-derived result graph, supervisor-result-graph:v2:<sha256>)`
    );
  }
  if (
    typeof entry.graphWorkflowId === "string" &&
    !SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE.test(
      entry.graphWorkflowId
    )
  ) {
    throw new Error(
      `${label} graphWorkflowId is not a message-derived result graph (supervisor-result-graph:v2:<sha256>), so no result could ever bind to it`
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
  return {
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
    policy,
    principal,
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
  };
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

const enrollConfiguredA2AV2Session = async (input: {
  config: A2AV2Config;
  directory: LoopSupervisorDirectory;
  now: () => string;
  service: SupervisorA2AV2Service;
}): Promise<void> => {
  const scope = {
    principal: input.config.principal,
    tenantId: input.config.tenant,
  };
  const route = await input.directory.resolve(input.config.recipient);
  if (!route || (route.target !== "codex" && route.target !== "claude")) {
    throw new Error(
      "configured A2A V2 recipient has no supported provider route"
    );
  }
  const status = readBridgeStatus(route.runDir);
  const endpoint =
    route.target === "codex"
      ? status.codexRemoteUrl
      : status.claudeChannelServer;
  const sessionId =
    route.target === "codex" ? status.codexThreadId : status.claudeSessionId;
  const provider =
    route.target === "codex" ? "codex-app-server" : "claude-code";
  if (!(endpoint && sessionId)) {
    throw new Error("configured A2A V2 recipient session is unavailable");
  }
  const issuedAt = input.now();
  const endpointDigest = createHash("sha256").update(endpoint).digest("hex");
  const current = await input.service.currentSession(
    scope,
    input.config.recipient
  );
  const sameLiveSession =
    current &&
    current.endpointDigest === endpointDigest &&
    current.endpointRef === input.config.endpointRef &&
    current.provider === provider &&
    current.sessionRef === `session:${sessionId}` &&
    current.expiresAt > issuedAt;
  if (sameLiveSession) {
    return;
  }
  const descriptor: SupervisorSessionDescriptorV2 = {
    descriptorId: deriveSupervisorSessionDescriptorV2Id(
      scope,
      input.config.recipient
    ),
    endpointDigest,
    endpointRef: input.config.endpointRef,
    expiresAt: new Date(
      Date.parse(issuedAt) + input.config.sessionTtlMs
    ).toISOString(),
    issuedAt,
    principal: scope.principal,
    provider,
    recipient: input.config.recipient,
    revision: current ? current.revision + 1 : 1,
    schema: "supervisor-session-descriptor.v2",
    sessionRef: `session:${sessionId}`,
    tenantId: scope.tenantId,
  };
  if (current) {
    await input.service.rebindSession(scope, descriptor);
  } else {
    await input.service.registerSession(scope, descriptor);
  }
};

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

const createDefaultRuntimeHost = async (input: {
  config: ServerConfig;
  connection: Connection;
  directory: LoopSupervisorDirectory;
  env: NodeJS.ProcessEnv;
  mailboxes: ReadonlyMap<string, string>;
  nativeConnection: NativeConnection;
}): Promise<{
  a2aV2Service: SupervisorA2AV2Service | undefined;
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
  });
  try {
    await enrollConfiguredA2AV2Session({
      config: a2aConfig,
      directory: input.directory,
      now: () => new Date().toISOString(),
      service: a2aV2Service,
    });
    const recipientBinding = input.config.supervisors.find(
      (entry) => entry.supervisorId === a2aConfig.recipient
    );
    for (const peer of input.config.supervisors) {
      if (
        peer.seat &&
        peer.supervisorId !== a2aConfig.recipient &&
        peer.manifestPath === recipientBinding?.manifestPath
      ) {
        await enrollConfiguredA2AV2Session({
          config: { ...a2aConfig, recipient: peer.supervisorId },
          directory: input.directory,
          now: () => new Date().toISOString(),
          service: a2aV2Service,
        });
      }
    }
    return { a2aV2Service, host: a2aV2Service.host };
  } catch (error) {
    await a2aV2Service.close().catch(() => undefined);
    throw error;
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
  if (config.a2aV2 && !env[config.a2aV2.databaseUrlEnv]) {
    throw new Error(
      `missing orchestration A2A V2 database environment ${config.a2aV2.databaseUrlEnv}`
    );
  }
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
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciliationHealthy = false;
  let reconciliationRunning = false;
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
    const reconcile = async () => {
      if (reconciliationRunning) {
        return;
      }
      reconciliationRunning = true;
      try {
        await reconciler.reconcile();
        await mailboxReconciler.reconcile();
        reconciliationHealthy = true;
      } catch (error) {
        reconciliationHealthy = false;
        console.error(
          `orchestration bridge reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      } finally {
        reconciliationRunning = false;
      }
    };
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
      reconciliationHealthy: () => reconciliationHealthy,
    });
    const server = serve({
      fetch: handler,
      hostname: config.hostname,
      port: config.port,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
        server.stop(true);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
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

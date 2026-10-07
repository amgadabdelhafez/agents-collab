import { timingSafeEqual } from "node:crypto";
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
import { BridgeSupervisorMessageDeliveryPort } from "./bridge-supervisor-message-delivery";
import { GOVERNESS_BEAT_WORKFLOW_TYPE } from "./governess-beat-workflow";
import { LoopSupervisorDirectory } from "./loop-supervisor-directory";
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
import { SUPERVISOR_MESSAGE_WORKFLOW_TYPE } from "./supervisor-message-workflow";
import type {
  SupervisorControlSurfaceAuthenticator,
  SupervisorControlSurfaceIdentity,
} from "./supervisor-orchestration-http";
import { JsonlSupervisorThreadStore } from "./supervisor-thread-store";
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
const TEMPORAL_ADDRESS_RE = /^[a-zA-Z0-9.:[\]-]{1,255}$/;

interface SupervisorConfig {
  // Absolute mailbox file for a supervisor with no Loop pane. Delivery to it is
  // POLLING-ONLY: the session reads the file on its own schedule.
  mailbox?: string;
  manifestPath?: string;
  principal: string;
  supervisorId: string;
  tokenEnv: string;
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
}

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
  const topLevel = Object.keys(value).filter((key) => key !== "deadlines");
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
      "supervisorId",
      "tokenEnv",
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
      ...(entry.mailbox === undefined
        ? {}
        : { mailbox: required(entry.mailbox, ABSOLUTE_PATH_RE, "mailbox") }),
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
  return {
    address: required(value.address, TEMPORAL_ADDRESS_RE, "address"),
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

export const runLoopOrchestrationServer = async (
  configPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const config = parseLoopOrchestrationConfig(readConfigFile(configPath));
  for (const supervisor of config.supervisors) {
    if (!env[supervisor.tokenEnv]) {
      throw new Error(
        `missing orchestration token environment ${supervisor.tokenEnv}`
      );
    }
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const directory = new LoopSupervisorDirectory(config.supervisors);
  const mailboxes = new Map(
    config.supervisors.flatMap((entry) =>
      entry.mailbox ? [[entry.supervisorId, entry.mailbox] as const] : []
    )
  );
  const connection = await Connection.connect({ address: config.address });
  const nativeConnection = await NativeConnection.connect({
    address: config.address,
  });
  let host: TemporalSupervisorRuntimeHost | undefined;
  let deadlineTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciliationHealthy = false;
  let reconciliationRunning = false;
  try {
    host = await TemporalSupervisorRuntimeHost.create({
      authority: authority(config),
      buildId: config.buildId,
      // A live Loop pane first; otherwise the recipient's mailbox, which is
      // durable but POLLING-ONLY: it cannot wake the session.
      delivery: new FirstAvailableDeliveryPort([
        new BridgeSupervisorMessageDeliveryPort({ directory }),
        new MailboxSupervisorMessageDeliveryPort({
          directory: { resolveMailbox: (id) => mailboxes.get(id) },
        }),
      ]),
      identity: config.identity,
      namespace: config.namespace,
      nativeConnection,
      receipts: new JsonlSupervisorMessageReceiptPort(
        join(config.stateDir, "governance.jsonl")
      ),
      store: new JsonlSupervisorThreadStore(
        join(config.stateDir, "threads.jsonl")
      ),
      taskQueue: config.taskQueue,
      workflowClient: new WorkflowClient({
        connection,
        namespace: config.namespace,
      }),
      workflowBundle: {
        code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
          "utf8"
        ),
      },
      workflowExecution: "in-process",
    });
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
    reconcileTimer = setInterval(() => {
      reconcile().catch((error) => {
        reconciliationHealthy = false;
        console.error(
          `orchestration bridge reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      });
    }, 250);
    const handler = host.httpHandler(authenticator(config, env));
    const server = serve({
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/healthz") {
          return Response.json({
            schema: "loop-orchestration-health.v1",
            state:
              host?.workerState() === "RUNNING" && reconciliationHealthy
                ? "ready"
                : "unavailable",
          });
        }
        return handler(request);
      },
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
    await host?.close();
    await nativeConnection.close();
    await connection.close();
  }
};

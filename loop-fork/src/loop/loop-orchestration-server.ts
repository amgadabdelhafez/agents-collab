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
  manifestPath: string;
  principal: string;
  supervisorId: string;
  tokenEnv: string;
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
  exactKeys(
    value,
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
    exactKeys(
      entry,
      ["manifestPath", "principal", "supervisorId", "tokenEnv"],
      "orchestration supervisor"
    );
    return {
      manifestPath: required(
        entry.manifestPath,
        ABSOLUTE_PATH_RE,
        "manifestPath"
      ),
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
  return {
    address: required(value.address, TEMPORAL_ADDRESS_RE, "address"),
    buildId: required(value.buildId, NAME_RE, "buildId"),
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
  const connection = await Connection.connect({ address: config.address });
  const nativeConnection = await NativeConnection.connect({
    address: config.address,
  });
  let host: TemporalSupervisorRuntimeHost | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let reconciliationHealthy = false;
  let reconciliationRunning = false;
  try {
    host = await TemporalSupervisorRuntimeHost.create({
      authority: authority(config),
      buildId: config.buildId,
      delivery: new BridgeSupervisorMessageDeliveryPort({ directory }),
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
    const reconciler = new SupervisorBridgeConsumptionReconciler({
      bindings: config.supervisors,
      directory,
      runtime: host.runtime,
    });
    const reconcile = async () => {
      if (reconciliationRunning) {
        return;
      }
      reconciliationRunning = true;
      try {
        await reconciler.reconcile();
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
    await host?.close();
    await nativeConnection.close();
    await connection.close();
  }
};

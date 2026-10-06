import { expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, Role, TaskState } from "@a2a-js/sdk";
import { JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { PostgresA2ATaskStore } from "../../src/loop/a2a-postgres-task-store";
import {
  agentCardFor,
  FROM_METADATA_KEY,
} from "../../src/loop/a2a-supervisor-adapter";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import { publishSupervisorA2AAcceptedResult } from "../../src/loop/a2a-supervisor-result";
import type { SupervisorA2AV2IngressLifecycle } from "../../src/loop/a2a-supervisor-v2-ingress";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  createSupervisorA2AV2Service,
  type SupervisorA2AV2Service,
} from "../../src/loop/supervisor-a2a-v2-service";
import {
  deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  SupervisorMessageV2ReadinessOutageTracker,
  SupervisorMessageV2ReadinessUnavailableError,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
  SupervisorSessionV2Error,
} from "../../src/loop/supervisor-session-v2";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import { WorkflowError } from "../../src/loop/workflow-port";

import { DisposablePostgres } from "../support/disposable-postgres";

const SCOPE = {
  principal: "principal:v2-service-test",
  tenantId: "tenant:v2-service-test",
};
const RECIPIENT = "supervisor:harness-desktop";
const PEER = "supervisor:harness-peer";
const SENDER = "supervisor:portfolio-coordinator";
const NOW = "2026-09-27T12:00:00.000Z";
const POLICY = {
  claimTimeoutMs: 60_000,
  escalationTimeoutMs: 120_000,
  maxDeliveryAttempts: 3,
  retryDelayMs: 1000,
};
/** A throwaway host secret, generated per run and never printed. */
const KEY = SupervisorResultGraphKey.fromSecret(
  randomBytes(32).toString("hex")
);

test("separate PostgreSQL result publishers atomically complete concurrent accepted follow-ups", async () => {
  const postgres = await DisposablePostgres.create();
  const stores: PostgresA2ATaskStore[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      stores.push(
        await PostgresA2ATaskStore.connect({
          databaseUrl: postgres.databaseUrl(),
        })
      );
    }
    await stores[0].migrate();
    const context = new ServerCallContext({
      tenant: SCOPE.tenantId,
      user: { isAuthenticated: true, userName: SCOPE.principal },
    });
    await stores[0].save(
      {
        id: "task:concurrent",
        contextId: "context:concurrent",
        history: [],
        artifacts: [],
        metadata: {
          [WORKFLOW_IDS_METADATA_KEY]: ["message:one", "message:two"],
        },
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: NOW,
          message: undefined,
        },
      },
      context
    );
    let arrived = 0;
    let release: () => void = () => {
      throw new Error("Barrier not initialized");
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = (store: PostgresA2ATaskStore, messageWorkflowId: string) =>
      publishSupervisorA2AAcceptedResult({
        store,
        context,
        binding: {
          a2aTaskId: "task:concurrent",
          messageWorkflowId,
          graphWorkflowId: "graph:concurrent",
          graphTaskId: "node:one",
          recipient: RECIPIENT,
        },
        now: () => NOW,
        verifyArtifact: async () => true,
        workflows: {
          query: async () => {
            arrived++;
            if (arrived === 2) {
              release();
            }
            await barrier;
            return {
              revision: 1,
              status: "completed" as const,
              workflowId: "graph:concurrent",
              value: {
                schema: "task-graph-projection.v1",
                nodes: [
                  {
                    taskId: "node:one",
                    workerId: RECIPIENT,
                    phase: "succeeded",
                    acceptanceReceipts: [
                      {
                        checkId: "check:one",
                        artifactRef: `artifact://sha256/${"a".repeat(64)}`,
                      },
                    ],
                  },
                ],
              },
            };
          },
        },
      });
    await Promise.all([
      publish(stores[0], "message:one"),
      publish(stores[1], "message:two"),
    ]);
    const persisted = await stores[1].load("task:concurrent", context);
    expect(persisted?.artifacts).toHaveLength(2);
    expect(persisted?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(
      persisted?.artifacts.map((artifact) => artifact.artifactId).sort()
    ).toEqual(["accepted:message:one", "accepted:message:two"]);
  } finally {
    await Promise.all(stores.map((store) => store.close()));
    await postgres.close();
  }
}, 30_000);

const message = (messageId: string): Message => ({
  contextId: "",
  extensions: [],
  messageId,
  metadata: { [FROM_METADATA_KEY]: SENDER },
  parts: [
    {
      content: { $case: "text" as const, value: "service factory proof" },
      filename: "",
      mediaType: "",
      metadata: undefined,
    },
  ],
  referenceTaskIds: [],
  role: Role.ROLE_USER,
  taskId: "",
});

const descriptor = (): SupervisorSessionDescriptorV2 => ({
  descriptorId: deriveSupervisorSessionDescriptorV2Id(SCOPE, RECIPIENT),
  endpointDigest: "a".repeat(64),
  endpointRef: "endpoint:service-factory-proof",
  expiresAt: "2026-09-28T12:00:00.000Z",
  issuedAt: "2026-09-27T11:00:00.000Z",
  principal: SCOPE.principal,
  provider: "controlled-test",
  recipient: RECIPIENT,
  revision: 1,
  schema: "supervisor-session-descriptor.v2",
  sessionRef: "session:service-factory-proof",
  tenantId: SCOPE.tenantId,
});

const serviceOptions = (input: {
  databaseUrl: string;
  environment: TestWorkflowEnvironment;
  /** The message-derived graph to allowlist, once the message exists. */
  graphWorkflowId?: string;
  root: string;
  taskQueue: string;
  delivery: {
    deliver: (
      envelope: SupervisorMessageV2DeliveryEnvelope
    ) => Promise<{ status: "accepted" }>;
  };
}) => ({
  card: {
    description: "Disposable standard A2A V2 service-factory proof.",
    supervisorId: RECIPIENT,
    url: "http://a2a.local/a2a",
  },
  databaseUrl: input.databaseUrl,
  peerRoutes: [{ pathname: "/a2a/seats/claude", supervisorId: PEER }],
  delivery: input.delivery,
  dispatchOwner: "v2-dispatcher:service-factory-proof",
  assignmentRoute: { pathname: "/assignment", principal: SCOPE.principal },
  resultGraphKey: KEY,
  resultGraphRoute: { pathname: "/result-graph", principal: SCOPE.principal },
  resultGraphTasks: ["result-node", "second-node"].flatMap((graphTaskId) =>
    input.graphWorkflowId
      ? [{ graphWorkflowId: input.graphWorkflowId, graphTaskId }]
      : []
  ),
  verifyResultArtifact: (reference: string, target: { graphTaskId: string }) =>
    Promise.resolve(
      target.graphTaskId === "result-node" &&
        reference ===
          `artifact://sha256/${createHash("sha256").update("controlled accepted result fixture v1\n").digest("hex")}`
    ),
  messageAuthority: {
    decide: () => ({
      allowed: true,
      authorityRef: "authority:service-factory-proof",
      reasonCode: "allowed",
    }),
  },
  host: {
    authority: {
      decide: () => ({
        allowed: true,
        authorityRef: "authority:service-factory-proof",
        reasonCode: "allowed",
      }),
    },
    buildId: "supervisor-a2a-v2-service-test.v1",
    delivery: {
      deliver: () => Promise.resolve({ status: "accepted" as const }),
    },
    identity: "supervisor-a2a-v2-service-test",
    namespace: input.environment.client.workflow.options.namespace,
    nativeConnection: input.environment.nativeConnection,
    receipts: { record: () => undefined },
    store: new JsonlSupervisorThreadStore(join(input.root, "threads.jsonl")),
    taskQueue: input.taskQueue,
    workflowClient: input.environment.client.workflow,
    workflowExecution: "in-process" as const,
    workflowsPath: new URL(
      "../../src/loop/temporal-workflow.ts",
      import.meta.url
    ).pathname,
  },
  now: () => NOW,
  policy: POLICY,
  providerReadiness: {
    ready: (current: SupervisorSessionDescriptorV2) => ({
      descriptorId: current.descriptorId,
      endpointDigest: current.endpointDigest,
      provider: current.provider,
      revision: current.revision,
      sessionRef: current.sessionRef,
      status: "ready" as const,
    }),
  },
  rebindAuthority: {
    decide: () => ({
      allowed: true,
      authorityRef: "authority:service-factory-proof",
      reasonCode: "allowed",
    }),
  },
  recoveryIntervalMs: 1000,
  recipientRoute: {
    pathname: "/recipient",
    principalForRecipient: (recipient: string) =>
      recipient === RECIPIENT ? "principal:recipient-seat" : undefined,
    authenticator: {
      authenticate: (request: Request) =>
        request.headers.get("authorization") === "Bearer recipient-fixture"
          ? { principal: "principal:recipient-seat", supervisorId: RECIPIENT }
          : undefined,
    },
  },
  route: {
    authenticator: {
      authenticate: (request: Request) =>
        request.headers.get("authorization") === "Bearer service-factory-token"
          ? { principal: SCOPE.principal, supervisorId: SENDER }
          : undefined,
    },
    tenant: SCOPE.tenantId,
  },
  supervisorId: RECIPIENT,
});

const clientFor = (
  service: SupervisorA2AV2Service,
  recipient = RECIPIENT,
  pathname = "/a2a"
) => {
  const fetchImpl: typeof fetch = Object.assign(
    (...[resource, init]: Parameters<typeof fetch>): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer service-factory-token");
      const url = resource instanceof Request ? resource.url : String(resource);
      return service.httpHandler(
        new Request(url, {
          ...init,
          headers,
        })
      );
    },
    { preconnect: fetch.preconnect }
  );
  return new JsonRpcTransportFactory({ fetchImpl }).create(
    `http://a2a.local${pathname}`,
    agentCardFor({
      description: "Disposable standard A2A V2 service-factory proof.",
      supervisorId: recipient,
      url: `http://a2a.local${pathname}`,
    })
  );
};

test("service factory closes every acquired resource after a partial migration failure without disclosing its database URL", async () => {
  const closes: string[] = [];
  const ledgerDeployments: string[] = [];
  const failure = await createSupervisorA2AV2Service({
    ...({
      card: {
        description: "partial cleanup",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      databaseUrl: "postgres://user:private-password@127.0.0.1:5432/private-db",
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" as const }),
      },
      dispatchOwner: "v2-dispatcher:partial-cleanup",
      host: {
        authority: {
          decide: () => ({
            allowed: true,
            authorityRef: "authority:test",
            reasonCode: "allowed",
          }),
        },
        buildId: "partial-cleanup.v1",
        delivery: {
          deliver: () => Promise.resolve({ status: "accepted" as const }),
        },
        identity: "partial-cleanup",
        namespace: "default",
        nativeConnection: {},
        receipts: { record: () => undefined },
        store: {} as JsonlSupervisorThreadStore,
        taskQueue: "partial-cleanup-queue",
        workflowBundle: { code: "unused" },
        workflowClient: {},
      },
      now: () => NOW,
      policy: POLICY,
      providerReadiness: { ready: () => ({}) as never },
      rebindAuthority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:test",
          reasonCode: "allowed",
        }),
      },
      route: {
        authenticator: { authenticate: () => undefined },
        tenant: SCOPE.tenantId,
      },
      supervisorId: RECIPIENT,
    } as const),
    dependencies: {
      connectLedger: (_databaseUrl, options) => {
        ledgerDeployments.push(options.deployment);
        return Promise.resolve({
          close: () => {
            closes.push("ledger");
            return Promise.resolve();
          },
          migrate: () =>
            Promise.reject(new Error("controlled second migration failure")),
        }) as never;
      },
      connectSessions: () =>
        Promise.reject(
          new Error("must not connect sessions after ledger migration failure")
        ),
      connectTaskStore: () =>
        Promise.resolve({
          close: () => {
            closes.push("task-store");
            return Promise.resolve();
          },
          migrate: () => Promise.resolve(),
        }) as never,
      createHost: () =>
        Promise.reject(
          new Error("must not create host after ledger migration failure")
        ),
      createWorkflows: () => {
        throw new Error(
          "must not create workflows after ledger migration failure"
        );
      },
    },
  }).then(
    () => "unexpected success",
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  expect(failure).toBe(
    "Supervisor A2A V2 service initialization failed at delivery-ledger (unclassified)"
  );
  expect(failure).not.toContain("private-password");
  expect(closes).toEqual(["ledger", "task-store"]);
  // The ledger mints workflow ids for the host's deployment: its task queue.
  expect(ledgerDeployments).toEqual(["partial-cleanup-queue"]);
});

const BIND_MESSAGE = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  "bind",
  "binding-wiring"
);
const BIND_GRAPH = deriveSupervisorMessageV2ResultGraphWorkflowId(
  KEY,
  SCOPE,
  BIND_MESSAGE
);

test("result binding refuses a graph not derived from the message, or a graph task the host has not configured or that is another worker's, before the ledger records it", async () => {
  const bound: unknown[] = [];
  const queried: string[] = [];
  const ledgerOptions: unknown[] = [];
  const closed = () => Promise.resolve();
  const create = (
    resultGraphTasks?: { graphTaskId: string; graphWorkflowId: string }[],
    resultGraphKey: SupervisorResultGraphKey | null = KEY,
    routes: {
      peerRoutes?: { pathname: string; supervisorId: string }[];
      resultGraphRoute?: { pathname: string; principal: string };
    } = {}
  ) =>
    createSupervisorA2AV2Service({
      ...({
        assignmentRoute: {
          pathname: "/assignment",
          principal: SCOPE.principal,
        },
        card: {
          description: "binding wiring",
          supervisorId: RECIPIENT,
          url: "http://a2a.local/a2a",
        },
        databaseUrl: "postgres://127.0.0.1:5432/unused",
        delivery: {
          deliver: () => Promise.resolve({ status: "accepted" as const }),
        },
        dispatchOwner: "v2-dispatcher:binding-wiring",
        host: {
          authority: {
            decide: () => ({
              allowed: true,
              authorityRef: "authority:test",
              reasonCode: "allowed",
            }),
          },
          buildId: "binding-wiring.v1",
          delivery: {
            deliver: () => Promise.resolve({ status: "accepted" as const }),
          },
          identity: "binding-wiring",
          namespace: "default",
          nativeConnection: {},
          receipts: { record: () => undefined },
          store: {} as JsonlSupervisorThreadStore,
          taskQueue: "binding-wiring",
          workflowBundle: { code: "unused" },
          workflowClient: {},
        },
        now: () => NOW,
        policy: POLICY,
        providerReadiness: { ready: () => ({}) as never },
        rebindAuthority: {
          decide: () => ({
            allowed: true,
            authorityRef: "authority:test",
            reasonCode: "allowed",
          }),
        },
        route: {
          authenticator: {
            authenticate: () => ({
              principal: SCOPE.principal,
              supervisorId: SENDER,
            }),
          },
          tenant: SCOPE.tenantId,
        },
        supervisorId: RECIPIENT,
      } as const),
      resultGraphKey: resultGraphKey ?? undefined,
      resultGraphTasks,
      ...routes,
      dependencies: {
        connectLedger: (_databaseUrl, options) => {
          ledgerOptions.push(options);
          return Promise.resolve({
            bindResult: (_scope: unknown, binding: unknown) => {
              bound.push(binding);
              return Promise.resolve();
            },
            close: closed,
            migrate: closed,
          }) as never;
        },
        connectSessions: () =>
          Promise.resolve({
            assertReady: closed,
            close: closed,
            migrate: closed,
          }) as never,
        connectTaskStore: () =>
          Promise.resolve({
            close: closed,
            load: () =>
              Promise.resolve({
                id: "task:bind",
                contextId: "context:bind",
                history: [],
                artifacts: [],
                metadata: { [WORKFLOW_IDS_METADATA_KEY]: [BIND_MESSAGE] },
                status: { state: TaskState.TASK_STATE_SUBMITTED },
              }),
            migrate: closed,
            save: closed,
          }) as never,
        createHost: () => Promise.resolve({ close: closed }) as never,
        createWorkflows: () =>
          ({
            query: (input: { workflowId: string }) => {
              queried.push(input.workflowId);
              return Promise.resolve({
                revision: 1,
                status: "running",
                workflowId: input.workflowId,
                value: {
                  schema: "task-graph-projection.v1",
                  nodes: [
                    { taskId: "node:mine", workerId: RECIPIENT },
                    { taskId: "node:theirs", workerId: PEER },
                  ],
                },
              });
            },
          }) as never,
      },
    });
  const binding = {
    a2aTaskId: "task:bind",
    messageWorkflowId: BIND_MESSAGE,
    graphWorkflowId: BIND_GRAPH,
    graphTaskId: "node:mine",
    recipient: RECIPIENT,
  };
  const unconfigured = await create();
  try {
    // The host's key and its deployment (task queue) reach the durable
    // ledger, which re-derives on its own.
    expect(ledgerOptions).toEqual([
      { deployment: "binding-wiring", resultGraphKey: KEY },
    ]);
    await expect(unconfigured.bindResult(SCOPE, binding)).rejects.toThrow(
      "not configured"
    );
  } finally {
    await unconfigured.close();
  }
  // Without the host key nothing binds, even an allowlisted derived graph.
  const keyless = await create(
    [{ graphWorkflowId: BIND_GRAPH, graphTaskId: "node:mine" }],
    null
  );
  try {
    await expect(keyless.bindResult(SCOPE, binding)).rejects.toThrow(
      "Result graph key is not configured"
    );
    await expect(
      keyless.startResultGraph(SCOPE, {
        input: {},
        messageWorkflowId: BIND_MESSAGE,
        requestId: "keyless-start",
      })
    ).rejects.toThrow("Result graph key is not configured");
  } finally {
    await keyless.close();
  }
  // The result graph route owns its path: neither the assignment route nor
  // a peer seat route may share it.
  for (const routes of [
    {
      resultGraphRoute: { pathname: "/assignment", principal: SCOPE.principal },
    },
    {
      peerRoutes: [{ pathname: "/result-graph", supervisorId: PEER }],
      resultGraphRoute: {
        pathname: "/result-graph",
        principal: SCOPE.principal,
      },
    },
  ]) {
    await expect(create([], KEY, routes)).rejects.toThrow(
      "initialization failed at http-routes"
    );
  }
  // Graphs not derived from this message under this host's key, even when
  // the host allowlists them: one the body names freely, the one derived for
  // the same message id under another tenant, the retired unkeyed v2 id that
  // anyone can compute, and the id under another host's key.
  const otherTenantGraph = deriveSupervisorMessageV2ResultGraphWorkflowId(
    KEY,
    { ...SCOPE, tenantId: "tenant:v2-service-other" },
    BIND_MESSAGE
  );
  const unkeyedGraph =
    deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId(
      SCOPE,
      BIND_MESSAGE
    );
  const otherKeyGraph = deriveSupervisorMessageV2ResultGraphWorkflowId(
    SupervisorResultGraphKey.fromSecret(randomBytes(32).toString("hex")),
    SCOPE,
    BIND_MESSAGE
  );
  const notDerived = [
    "graph:chosen-by-body",
    otherTenantGraph,
    unkeyedGraph,
    otherKeyGraph,
  ];
  const service = await create([
    { graphWorkflowId: BIND_GRAPH, graphTaskId: "node:mine" },
    { graphWorkflowId: BIND_GRAPH, graphTaskId: "node:theirs" },
    ...notDerived.map((graphWorkflowId) => ({
      graphWorkflowId,
      graphTaskId: "node:mine",
    })),
  ]);
  try {
    await expect(
      service.bindResult(SCOPE, { ...binding, graphTaskId: "node:unlisted" })
    ).rejects.toThrow("not configured");
    for (const graphWorkflowId of notDerived) {
      await expect(
        service.bindResult(SCOPE, { ...binding, graphWorkflowId })
      ).rejects.toThrow("not derived from this message");
      const body = await service.assignmentRoute?.httpHandler(
        new Request("http://local/assignment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...binding, graphWorkflowId }),
        })
      );
      expect(body?.status).toBe(409);
    }
    expect(queried).toEqual([]);
    const refused = await service.assignmentRoute?.httpHandler(
      new Request("http://local/assignment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...binding, graphTaskId: "node:unlisted" }),
      })
    );
    expect(refused?.status).toBe(409);
    await expect(
      service.bindResult(SCOPE, { ...binding, graphTaskId: "node:theirs" })
    ).rejects.toThrow("unrelated");
    expect(bound).toEqual([]);
    await service.bindResult(SCOPE, binding);
    expect(bound).toEqual([binding]);
  } finally {
    await service.close();
  }
});

const enrollmentProbe = (
  enrollSessions: NonNullable<
    Parameters<typeof createSupervisorA2AV2Service>[0]["enrollSessions"]
  >
) => {
  const events: string[] = [];
  const closer = (name: string) => () => {
    events.push(`closed:${name}`);
    return Promise.resolve();
  };
  const created = createSupervisorA2AV2Service({
    ...({
      card: {
        description: "enrollment ordering",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      databaseUrl: "postgres://user:private-password@127.0.0.1:5432/private-db",
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" as const }),
      },
      dispatchOwner: "v2-dispatcher:enrollment-ordering",
      host: {
        authority: {
          decide: () => ({
            allowed: true,
            authorityRef: "authority:test",
            reasonCode: "allowed",
          }),
        },
        buildId: "enrollment-ordering.v1",
        delivery: {
          deliver: () => Promise.resolve({ status: "accepted" as const }),
        },
        identity: "enrollment-ordering",
        namespace: "default",
        nativeConnection: {},
        receipts: { record: () => undefined },
        store: {} as JsonlSupervisorThreadStore,
        taskQueue: "enrollment-ordering",
        workflowBundle: { code: "unused" },
        workflowClient: {},
      },
      now: () => NOW,
      policy: POLICY,
      providerReadiness: { ready: () => ({}) as never },
      rebindAuthority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:test",
          reasonCode: "allowed",
        }),
      },
      route: {
        authenticator: { authenticate: () => undefined },
        tenant: SCOPE.tenantId,
      },
      supervisorId: RECIPIENT,
    } as const),
    dependencies: {
      connectLedger: () =>
        Promise.resolve({
          close: closer("ledger"),
          migrate: () => Promise.resolve(),
        }) as never,
      connectSessions: () =>
        Promise.resolve({
          assertReady: () => {
            events.push("assertReady");
            return Promise.reject(new Error("unexpected readiness check"));
          },
          close: closer("sessions"),
          current: (_scope: unknown, recipient: string) => {
            events.push(`current:${recipient}`);
            return Promise.resolve(undefined);
          },
          migrate: () => Promise.resolve(),
          rebind: () => Promise.reject(new Error("unexpected rebind")),
          register: (
            _scope: unknown,
            descriptor: SupervisorSessionDescriptorV2
          ) => {
            events.push(`register:${descriptor.recipient}`);
            return Promise.resolve(descriptor);
          },
        }) as never,
      connectTaskStore: () =>
        Promise.resolve({
          close: closer("task-store"),
          migrate: () => Promise.resolve(),
        }) as never,
      createHost: () => {
        // Host creation starts ingress recovery, whose readiness checks need
        // a current descriptor. Stop here: only the ordering is under test.
        events.push("host");
        return Promise.reject(new Error("controlled host stop"));
      },
      createWorkflows: () => ({}) as never,
    },
    enrollSessions: (sessions) => {
      events.push("enroll");
      return enrollSessions(sessions);
    },
  }).then(
    () => "unexpected success",
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  return { created, events };
};

test("service factory enrolls sessions before the runtime host starts ingress recovery", async () => {
  const probe = enrollmentProbe(async (sessions) => {
    expect(await sessions.currentSession(SCOPE, RECIPIENT)).toBeUndefined();
    await sessions.registerSession(SCOPE, {
      recipient: RECIPIENT,
    } as SupervisorSessionDescriptorV2);
  });
  expect(await probe.created).toBe(
    "Supervisor A2A V2 service initialization failed at runtime-host (unclassified)"
  );
  expect(probe.events.slice(0, 4)).toEqual([
    "enroll",
    `current:${RECIPIENT}`,
    `register:${RECIPIENT}`,
    "host",
  ]);
});

test("service factory refuses start on a failed enrollment before creating the host", async () => {
  const probe = enrollmentProbe(() =>
    Promise.reject(
      new Error("configured A2A V2 recipient session is unavailable")
    )
  );
  const failure = await probe.created;
  expect(failure).toBe(
    "Supervisor A2A V2 service initialization failed at session-enrollment (unclassified)"
  );
  expect(failure).not.toContain("private-password");
  expect(probe.events).toEqual([
    "enroll",
    "closed:sessions",
    "closed:ledger",
    "closed:task-store",
  ]);
});

test("standard V2 factory authenticates before task mutation and preserves scoped delivery and DAG readiness across host recreation", async () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-a2a-v2-service-"));
  const address = process.env.LOOP_VERTICAL_TEMPORAL_ADDRESS;
  const namespace = process.env.LOOP_VERTICAL_TEMPORAL_NAMESPACE;
  if (Boolean(address) !== Boolean(namespace)) {
    throw new Error(
      "existing Temporal proof requires both address and namespace"
    );
  }
  const environment =
    address && namespace
      ? await TestWorkflowEnvironment.createFromExistingServer({
          address,
          namespace,
        })
      : await TestWorkflowEnvironment.createLocal();
  let postgres: DisposablePostgres | undefined;
  let adminSessions: PostgresSupervisorSessionV2Store | undefined;
  let service: SupervisorA2AV2Service | undefined;
  let recreated: SupervisorA2AV2Service | undefined;
  let deliveries = 0;
  const ownedWorkflowIds = new Set<string>();
  const messageId = `factory-reconnect-${randomUUID()}`;
  const taskQueue = `supervisor-a2a-v2-service-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    postgres = await DisposablePostgres.create();
    const sessionInput = {
      authority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:service-factory-proof",
          reasonCode: "allowed",
        }),
      },
      databaseUrl: postgres.databaseUrl(),
      now: () => NOW,
      provider: {
        ready: (current: SupervisorSessionDescriptorV2) => ({
          descriptorId: current.descriptorId,
          endpointDigest: current.endpointDigest,
          provider: current.provider,
          revision: current.revision,
          sessionRef: current.sessionRef,
          status: "ready" as const,
        }),
      },
    };
    adminSessions =
      await PostgresSupervisorSessionV2Store.connect(sessionInput);
    await adminSessions.migrate();
    await adminSessions.register(SCOPE, descriptor());
    await adminSessions.register(SCOPE, {
      ...descriptor(),
      recipient: PEER,
      descriptorId: deriveSupervisorSessionDescriptorV2Id(SCOPE, PEER),
    });
    const delivery = {
      deliver: (envelope: SupervisorMessageV2DeliveryEnvelope) => {
        ownedWorkflowIds.add(envelope.workflowId);
        deliveries += 1;
        return Promise.resolve({ status: "accepted" as const });
      },
    };
    service = await createSupervisorA2AV2Service(
      serviceOptions({
        databaseUrl: postgres.databaseUrl(),
        delivery,
        environment,
        root,
        taskQueue,
      })
    );
    const unauthenticated = await service.httpHandler(
      new Request("http://a2a.local/a2a", {
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(unauthenticated.status).toBe(401);
    const tenantMismatch = await service.httpHandler(
      new Request("http://a2a.local/a2a", {
        body: JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "message/send",
          params: { tenant: "tenant:not-authorized" },
        }),
        headers: {
          authorization: "Bearer service-factory-token",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    expect(tenantMismatch.status).toBe(400);
    expect(deliveries).toBe(0);

    const client = await clientFor(service);
    const submitted = await client.sendMessage({
      configuration: undefined,
      message: message(messageId),
      metadata: undefined,
      tenant: SCOPE.tenantId,
    });
    expect(deliveries).toBe(1);
    const workflowId = [...ownedWorkflowIds][0];
    if (!(workflowId && service.governance)) {
      throw new Error("Missing composed governance or delivered workflow");
    }
    // The only graph this message's result may bind to is derived from the
    // message itself. The recreated host allowlists its tasks.
    const graphWorkflowId = deriveSupervisorMessageV2ResultGraphWorkflowId(
      KEY,
      SCOPE,
      workflowId
    );
    if (!service.recipientRoute) {
      throw new Error("Missing composed recipient route");
    }
    const recipientResponse = await service.recipientRoute.httpHandler(
      new Request("http://local/recipient", {
        method: "POST",
        headers: {
          authorization: "Bearer recipient-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "claim",
          requestId: "service-proof-http-claim",
          workflowId,
        }),
      })
    );
    expect(recipientResponse.status).toBe(200);
    expect(await recipientResponse.json()).toMatchObject({
      phase: "claimed",
      workResultCompleted: false,
    });
    const assignmentLedger =
      await PostgresSupervisorMessageV2DeliveryLedger.connect(
        postgres.databaseUrl(),
        { deployment: taskQueue }
      );
    try {
      await expect(
        assignmentLedger.recipientAssignment({
          tenantId: SCOPE.tenantId,
          recipient: RECIPIENT,
          workflowId,
        })
      ).resolves.toEqual(SCOPE);
      await expect(
        assignmentLedger.recipientAssignment({
          tenantId: "tenant:foreign",
          recipient: RECIPIENT,
          workflowId,
        })
      ).resolves.toBeUndefined();
      await expect(
        assignmentLedger.recipientAssignment({
          tenantId: SCOPE.tenantId,
          recipient: "supervisor:foreign",
          workflowId,
        })
      ).resolves.toBeUndefined();
      // Recovery's retention boundary: an accepted delivery is durable proof
      // the workflow ran, visible only inside its own trusted scope.
      await expect(
        assignmentLedger.hasCompletedDelivery(workflowId, SCOPE)
      ).resolves.toBe(true);
      await expect(
        assignmentLedger.hasCompletedDelivery(workflowId, {
          ...SCOPE,
          tenantId: "tenant:foreign",
        })
      ).resolves.toBe(false);
      await expect(
        assignmentLedger.hasCompletedDelivery(
          `supervisor-message-workflow:v2:${"0".repeat(64)}`,
          SCOPE
        )
      ).resolves.toBe(false);
    } finally {
      await assignmentLedger.close();
    }
    await expect(
      service.host.sessionGateStatus(SCOPE, RECIPIENT)
    ).resolves.toMatchObject({
      ready: true,
      schema: "supervisor-session-dag-gate-status.v2",
    });
    await Promise.all([service.close(), service.close()]);
    service = undefined;

    recreated = await createSupervisorA2AV2Service(
      serviceOptions({
        databaseUrl: postgres.databaseUrl(),
        delivery,
        environment,
        graphWorkflowId,
        root,
        taskQueue,
      })
    );
    const retryClient = await clientFor(recreated);
    await retryClient.sendMessage({
      configuration: undefined,
      message: message(messageId),
      metadata: undefined,
      tenant: SCOPE.tenantId,
    });
    expect(deliveries).toBe(1);
    if (!recreated.governance) {
      throw new Error("Missing recreated governance");
    }
    await expect(
      recreated.governance.acknowledge({
        claimant: RECIPIENT,
        requestId: "service-proof-ack",
        trustedScope: SCOPE,
        workflowId,
      })
    ).resolves.toMatchObject({ claimedBy: RECIPIENT, phase: "acknowledged" });
    if (!("id" in submitted)) {
      throw new Error("Expected an A2A task");
    }
    const workflows = new TemporalWorkflowPort(environment.client.workflow, {
      taskQueue,
    });
    const resultBytes = Buffer.from("controlled accepted result fixture v1\n");
    const artifactRef = `artifact://sha256/${createHash("sha256").update(resultBytes).digest("hex")}`;
    ownedWorkflowIds.add(graphWorkflowId);
    await workflows.start({
      workflowId: graphWorkflowId,
      workflowType: "task-graph.v1",
      requestId: "result-graph-start",
      input: {
        schema: "task-graph.v1",
        graphId: "result-proof",
        nodes: [
          {
            taskId: "result-node",
            acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
            authorityGates: [],
            dependencies: [],
            ownerRepository: "agents-collab",
            readScopes: ["src"],
            writeScopes: [],
            specArtifactRef: artifactRef,
          },
          {
            taskId: "second-node",
            acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
            authorityGates: [],
            dependencies: [],
            ownerRepository: "agents-collab",
            readScopes: ["src"],
            writeScopes: [],
            specArtifactRef: artifactRef,
          },
        ],
      },
    });
    await workflows.signal({
      workflowId: graphWorkflowId,
      name: "claim",
      requestId: "result-claim",
      payload: { taskId: "result-node", workerId: RECIPIENT },
    });
    await workflows.signal({
      workflowId: graphWorkflowId,
      name: "start",
      requestId: "result-running",
      payload: { taskId: "result-node", workerId: RECIPIENT },
    });
    const context = new ServerCallContext({
      tenant: SCOPE.tenantId,
      user: { isAuthenticated: true, userName: SCOPE.principal },
    });
    let results = await PostgresA2ATaskStore.connect({
      databaseUrl: postgres.databaseUrl(),
    });
    const binding = {
      a2aTaskId: submitted.id,
      messageWorkflowId: workflowId,
      graphWorkflowId,
      graphTaskId: "result-node",
      recipient: RECIPIENT,
    };
    if (!recreated.assignmentRoute) {
      throw new Error("Missing assignment HTTP route");
    }
    const assign = (token: string) =>
      recreated?.assignmentRoute?.httpHandler(
        new Request("http://local/assignment", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(binding),
        })
      );
    expect((await assign("recipient-fixture"))?.status).toBe(401);
    expect((await assign("service-factory-token"))?.status).toBe(200);
    await recreated.bindResult(SCOPE, binding);
    // A graph task the host has not allowlisted is refused before the graph.
    await expect(
      recreated.bindResult(SCOPE, { ...binding, graphTaskId: "foreign-node" })
    ).rejects.toThrow("not configured");
    // A second, allowlisted graph task cannot replace the immutable binding.
    await expect(
      recreated.bindResult(SCOPE, { ...binding, graphTaskId: "second-node" })
    ).rejects.toThrow("conflicts with prior assignment");
    await recreated.close();
    recreated = await createSupervisorA2AV2Service(
      serviceOptions({
        databaseUrl: postgres.databaseUrl(),
        delivery,
        environment,
        graphWorkflowId,
        root,
        taskQueue,
      })
    );
    const publish = () => {
      if (!recreated) {
        throw new Error("Missing result service");
      }
      return recreated.publishResult(SCOPE, {
        workflowId,
        taskId: submitted.id,
        recipient: RECIPIENT,
      });
    };
    try {
      await expect(publish()).rejects.toThrow("not accepted");
      await workflows.signal({
        workflowId: graphWorkflowId,
        name: "complete",
        requestId: "result-accepted",
        payload: {
          taskId: "result-node",
          workerId: RECIPIENT,
          receipts: [{ checkId: "artifact", artifactRef }],
        },
      });
      await publish();
      expect((await results.load(submitted.id, context))?.status?.state).toBe(
        TaskState.TASK_STATE_COMPLETED
      );
      if (!recreated.recipientRoute) {
        throw new Error("Missing result HTTP route");
      }
      const httpResult = await recreated.recipientRoute.httpHandler(
        new Request("http://local/recipient", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer recipient-fixture",
          },
          body: JSON.stringify({
            operation: "publish-result",
            requestId: "result-http-retry",
            workflowId,
            taskId: submitted.id,
          }),
        })
      );
      expect(httpResult.status).toBe(200);
      expect(await httpResult.json()).toMatchObject({
        resultPublished: true,
        taskId: submitted.id,
      });
      await results.close();
      results = await PostgresA2ATaskStore.connect({
        databaseUrl: postgres.databaseUrl(),
      });
      await publish();
      expect(
        (await results.load(submitted.id, context))?.artifacts
      ).toHaveLength(1);
    } finally {
      await results.close();
    }
    await expect(
      recreated.host.sessionGateStatus(SCOPE, RECIPIENT)
    ).resolves.toMatchObject({
      ready: true,
    });
    const unauthPeer = await recreated.httpHandler(
      new Request("http://a2a.local/a2a/seats/claude", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );
    expect(unauthPeer.status).toBe(401);
    const peerClient = await clientFor(recreated, PEER, "/a2a/seats/claude");
    const peerTask = await peerClient.sendMessage({
      configuration: undefined,
      message: message(`${messageId}:peer`),
      metadata: undefined,
      tenant: SCOPE.tenantId,
    });
    expect("id" in peerTask).toBe(true);
    expect(deliveries).toBe(2);
    const peerWorkflow = [...ownedWorkflowIds].find(
      (id) => id !== workflowId && id !== graphWorkflowId
    );
    if (!(peerWorkflow && "id" in peerTask)) {
      throw new Error("Missing delivered peer workflow");
    }
    const peerBinding = {
      a2aTaskId: peerTask.id,
      messageWorkflowId: peerWorkflow,
      graphWorkflowId,
      graphTaskId: "result-node",
      recipient: PEER,
    };
    // The first message's graph is not the peer message's: the same tenant
    // and principal cannot attach one message to another message's work.
    await expect(recreated.bindResult(SCOPE, peerBinding)).rejects.toThrow(
      "not derived from this message"
    );
    const reservation = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      postgres.databaseUrl(),
      { deployment: taskQueue, resultGraphKey: KEY }
    );
    try {
      // The ledger refuses it on its own and records nothing for the peer.
      await expect(reservation.bindResult(SCOPE, peerBinding)).rejects.toThrow(
        "not derived from this message"
      );
      await expect(
        reservation.resultBinding(SCOPE, peerWorkflow, peerTask.id)
      ).resolves.toBeUndefined();
      // The published binding still holds its reservation.
      await expect(
        reservation.resultBinding(SCOPE, workflowId, submitted.id)
      ).resolves.toEqual(binding);
    } finally {
      await reservation.close();
    }
    const projection = await environment.client.workflow
      .getHandle(peerWorkflow)
      .query<{ value: { to: string } }>("workflow-port-query", "status", {
        trustedScope: SCOPE,
      });
    expect(projection.value.to).toBe(PEER);
    await recreated.close();
    recreated = undefined;
    const terminalRuns = new Map<string, string>();
    for (const id of [workflowId, peerWorkflow]) {
      const handle = environment.client.workflow.getHandle(id);
      await handle.terminate("controlled terminal-history recovery proof");
      terminalRuns.set(id, (await handle.describe()).runId);
    }
    recreated = await createSupervisorA2AV2Service(
      serviceOptions({
        databaseUrl: postgres.databaseUrl(),
        delivery,
        environment,
        graphWorkflowId,
        root,
        taskQueue,
      })
    );
    expect(deliveries).toBe(2);
    for (const [id, runId] of terminalRuns) {
      const description = await environment.client.workflow
        .getHandle(id)
        .describe();
      expect(description.status.name).toBe("TERMINATED");
      expect(description.runId).toBe(runId);
    }
  } finally {
    await recreated?.close().catch(() => undefined);
    await service?.close().catch(() => undefined);
    await adminSessions?.close().catch(() => undefined);
    // Only executions whose immutable envelope this test actually received.
    // Existing server histories are retained; unrelated queues are untouched.
    for (const workflowId of ownedWorkflowIds) {
      const handle = environment.client.workflow.getHandle(workflowId);
      if ((await handle.describe()).status.name === "RUNNING") {
        await handle.terminate("vertical service proof cleanup");
      }
    }
    await environment.teardown();
    await postgres?.close();
    rmSync(root, { force: true, recursive: true });
  }
}, 90_000);

test("a stopped PostgreSQL session store reports readiness unavailable, not an unready seat, without its database URL", async () => {
  let postgres: DisposablePostgres | undefined;
  let sessions: PostgresSupervisorSessionV2Store | undefined;
  let alive = true;
  try {
    postgres = await DisposablePostgres.create();
    const databaseUrl = postgres.databaseUrl();
    const password = decodeURIComponent(new URL(databaseUrl).password);
    sessions = await PostgresSupervisorSessionV2Store.connect({
      authority: {
        decide: () => ({
          allowed: false,
          authorityRef: "authority:none",
          reasonCode: "denied",
        }),
      },
      databaseUrl,
      now: () => NOW,
      provider: {
        ready: (current: SupervisorSessionDescriptorV2) => {
          if (!alive) {
            throw new Error("controlled seat is gone");
          }
          return {
            descriptorId: current.descriptorId,
            endpointDigest: current.endpointDigest,
            provider: current.provider,
            revision: current.revision,
            sessionRef: current.sessionRef,
            status: "ready" as const,
          };
        },
      },
    });
    await sessions.migrate();
    await sessions.register(SCOPE, descriptor());
    await expect(sessions.assertReady(SCOPE, RECIPIENT)).resolves.toMatchObject(
      { status: "ready" }
    );

    // A dead seat over a live store is an ordinary readiness refusal.
    alive = false;
    const unready = await sessions
      .assertReady(SCOPE, RECIPIENT)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(unready).toBeInstanceOf(Error);
    expect(unready).not.toBeInstanceOf(
      SupervisorMessageV2ReadinessUnavailableError
    );
    alive = true;

    // The store itself goes away.
    await postgres.close();
    postgres = undefined;
    const unavailable = await sessions
      .assertReady(SCOPE, RECIPIENT)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(
      SupervisorMessageV2ReadinessUnavailableError
    );
    const rendered = `${String(unavailable)} ${JSON.stringify(unavailable)} ${
      (unavailable as Error).stack
    }`;
    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain(databaseUrl);
  } finally {
    await sessions?.close().catch(() => undefined);
    await postgres?.close();
  }
}, 60_000);

const resultGraphInput = (artifactRef: string) => ({
  schema: "task-graph.v1",
  graphId: "keyed-result-proof",
  nodes: [
    {
      taskId: "result-node",
      acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["src"],
      writeScopes: [],
      specArtifactRef: artifactRef,
    },
  ],
});

test("end to end on PostgreSQL and Temporal: send a message, start its result graph under the keyed id, bind, publish, COMPLETED", async () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-a2a-v2-keyed-graph-"));
  const environment = await TestWorkflowEnvironment.createLocal();
  let postgres: DisposablePostgres | undefined;
  let adminSessions: PostgresSupervisorSessionV2Store | undefined;
  let service: SupervisorA2AV2Service | undefined;
  let results: PostgresA2ATaskStore | undefined;
  const ownedWorkflowIds = new Set<string>();
  const taskQueue = `supervisor-a2a-v2-keyed-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    postgres = await DisposablePostgres.create();
    adminSessions = await PostgresSupervisorSessionV2Store.connect({
      authority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:keyed-graph-proof",
          reasonCode: "allowed",
        }),
      },
      databaseUrl: postgres.databaseUrl(),
      now: () => NOW,
      provider: { ready: () => ({}) as never },
    });
    await adminSessions.migrate();
    await adminSessions.register(SCOPE, descriptor());
    const delivery = {
      deliver: (envelope: SupervisorMessageV2DeliveryEnvelope) => {
        ownedWorkflowIds.add(envelope.workflowId);
        return Promise.resolve({ status: "accepted" as const });
      },
    };
    const options = (graphWorkflowId?: string) =>
      serviceOptions({
        databaseUrl: (postgres as DisposablePostgres).databaseUrl(),
        delivery,
        environment,
        graphWorkflowId,
        root,
        taskQueue,
      });
    service = await createSupervisorA2AV2Service(options());

    // 1. Send: an authenticated A2A message records the V2 message.
    const submitted = await (await clientFor(service)).sendMessage({
      configuration: undefined,
      message: message(`keyed-graph-${randomUUID()}`),
      metadata: undefined,
      tenant: SCOPE.tenantId,
    });
    const messageWorkflowId = [...ownedWorkflowIds][0];
    if (!(messageWorkflowId && "id" in submitted)) {
      throw new Error("Expected a delivered message and an A2A task");
    }

    // 2. Start the message's result graph through the message-driven route.
    // The caller names the message, never the graph id, and holds no key.
    const resultBytes = Buffer.from("controlled accepted result fixture v1\n");
    const artifactRef = `artifact://sha256/${createHash("sha256").update(resultBytes).digest("hex")}`;
    const startGraph = (
      token: string,
      body: Record<string, unknown> = {
        input: resultGraphInput(artifactRef),
        messageWorkflowId,
        requestId: "keyed-graph-start",
      }
    ) =>
      (service as SupervisorA2AV2Service).resultGraphRoute?.httpHandler(
        new Request("http://local/result-graph", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ) as Promise<Response>;
    expect((await startGraph("recipient-fixture")).status).toBe(401);
    // A message this scope never sent has no result graph here.
    expect(
      (
        await startGraph("service-factory-token", {
          input: resultGraphInput(artifactRef),
          messageWorkflowId: deriveSupervisorMessageV2WorkflowId(
            SCOPE,
            "never-sent",
            taskQueue
          ),
          requestId: "keyed-graph-unknown",
        })
      ).status
    ).toBe(409);
    const started = await startGraph("service-factory-token");
    expect(started.status).toBe(200);
    const receipt = (await started.json()) as {
      created: boolean;
      graphWorkflowId: string;
      messageWorkflowId: string;
      schema: string;
    };
    // The route derived exactly the id the operator tool computes.
    const graphWorkflowId = deriveSupervisorMessageV2ResultGraphWorkflowId(
      KEY,
      SCOPE,
      messageWorkflowId
    );
    ownedWorkflowIds.add(graphWorkflowId);
    expect(receipt).toEqual({
      schema: "supervisor-result-graph-start-receipt.v1",
      messageWorkflowId,
      graphWorkflowId,
      created: true,
    });
    // A response-loss retry is the same start, not a second graph.
    const retried = await startGraph("service-factory-token");
    expect(await retried.json()).toMatchObject({
      graphWorkflowId,
      created: false,
    });
    const handle = environment.client.workflow.getHandle(graphWorkflowId);
    expect((await handle.describe()).status.name).toBe("RUNNING");

    // 3. Bind. The host has not configured this graph task yet.
    const binding = {
      a2aTaskId: submitted.id,
      messageWorkflowId,
      graphWorkflowId,
      graphTaskId: "result-node",
      recipient: RECIPIENT,
    };
    const assign = () =>
      (service as SupervisorA2AV2Service).assignmentRoute?.httpHandler(
        new Request("http://local/assignment", {
          method: "POST",
          headers: {
            authorization: "Bearer service-factory-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(binding),
        })
      );
    expect((await assign())?.status).toBe(409);
    // The operator adds the computed id to the host's result artifacts.
    await service.close();
    service = await createSupervisorA2AV2Service(options(graphWorkflowId));
    expect((await assign())?.status).toBe(200);

    // 4. The recipient does the work in the graph and it is accepted.
    const workflows = new TemporalWorkflowPort(environment.client.workflow, {
      taskQueue,
    });
    for (const [name, requestId] of [
      ["claim", "keyed-claim"],
      ["start", "keyed-running"],
    ] as const) {
      await workflows.signal({
        workflowId: graphWorkflowId,
        name,
        requestId,
        payload: { taskId: "result-node", workerId: RECIPIENT },
      });
    }
    await workflows.signal({
      workflowId: graphWorkflowId,
      name: "complete",
      requestId: "keyed-accepted",
      payload: {
        taskId: "result-node",
        workerId: RECIPIENT,
        receipts: [{ checkId: "artifact", artifactRef }],
      },
    });

    // 5. Publish through the recipient route: the A2A task completes.
    const published = await service.recipientRoute?.httpHandler(
      new Request("http://local/recipient", {
        method: "POST",
        headers: {
          authorization: "Bearer recipient-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "publish-result",
          requestId: "keyed-publish",
          workflowId: messageWorkflowId,
          taskId: submitted.id,
        }),
      })
    );
    expect(published?.status).toBe(200);
    expect(await published?.json()).toMatchObject({
      resultPublished: true,
      taskId: submitted.id,
    });
    results = await PostgresA2ATaskStore.connect({
      databaseUrl: postgres.databaseUrl(),
    });
    const completed = await results.load(
      submitted.id,
      new ServerCallContext({
        tenant: SCOPE.tenantId,
        user: { isAuthenticated: true, userName: SCOPE.principal },
      })
    );
    expect(completed?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(completed?.artifacts.map((artifact) => artifact.artifactId)).toEqual(
      [`accepted:${messageWorkflowId}`]
    );
  } finally {
    await results?.close().catch(() => undefined);
    await service?.close().catch(() => undefined);
    await adminSessions?.close().catch(() => undefined);
    for (const workflowId of ownedWorkflowIds) {
      const handle = environment.client.workflow.getHandle(workflowId);
      const description = await handle.describe().catch(() => undefined);
      if (description?.status.name === "RUNNING") {
        await handle.terminate("keyed result graph proof cleanup");
      }
    }
    await environment.teardown();
    await postgres?.close();
    rmSync(root, { force: true, recursive: true });
  }
}, 90_000);

test("every V2 delivery path of one service shares its readiness-outage bound, log line, and counters", async () => {
  const [fixture] = supervisorMessageV2ReplayFixtures;
  if (!fixture) {
    throw new Error("missing V2 fixture");
  }
  const scope = fixture.expectedScope;
  let clock = Date.parse(NOW);
  const now = () => new Date(clock).toISOString();
  const workflows = new InMemoryWorkflowPort({
    definitions: [supervisorMessageV2WorkflowDefinition],
    now,
  });
  let ingress: SupervisorA2AV2IngressLifecycle | undefined;
  let postgres: DisposablePostgres | undefined;
  let service: SupervisorA2AV2Service | undefined;
  let ledger: PostgresSupervisorMessageV2DeliveryLedger | undefined;
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    postgres = await DisposablePostgres.create();
    const databaseUrl = postgres.databaseUrl();
    service = await createSupervisorA2AV2Service({
      assignmentRoute: { pathname: "/assignment", principal: scope.principal },
      card: {
        description: "shared readiness outage",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      databaseUrl,
      delivery: {
        deliver: () => Promise.reject(new Error("store is down: no delivery")),
      },
      dispatchOwner: "v2-dispatcher:shared-outage",
      // Only the deployment (task queue) is read before createHost.
      host: { taskQueue: "shared-outage-queue" } as never,
      messageAuthority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:test",
          reasonCode: "allowed",
        }),
      },
      now,
      peerRoutes: [{ pathname: "/a2a/seats/peer", supervisorId: PEER }],
      policy: POLICY,
      providerReadiness: { ready: () => ({}) as never },
      readinessOutageBoundMs: 120_000,
      rebindAuthority: {
        decide: () => ({
          allowed: false,
          authorityRef: "authority:none",
          reasonCode: "denied",
        }),
      },
      route: {
        authenticator: {
          authenticate: (request: Request) =>
            request.headers.get("authorization") === "Bearer outage-control"
              ? { principal: scope.principal, supervisorId: RECIPIENT }
              : undefined,
        },
        tenant: scope.tenantId,
      },
      supervisorId: RECIPIENT,
      dependencies: {
        connectLedger: async (url, options) => {
          ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
            url,
            options
          );
          return ledger;
        },
        connectSessions: () =>
          Promise.resolve({
            // The session store itself is down for every recipient.
            assertReady: () =>
              Promise.reject(
                new SupervisorMessageV2ReadinessUnavailableError()
              ),
            close: () => Promise.resolve(),
            current: () => Promise.resolve(undefined),
            migrate: () => Promise.resolve(),
            rebind: () => Promise.reject(new Error("unused")),
            register: () => Promise.reject(new Error("unused")),
            status: () => Promise.reject(new Error("unused")),
          }) as never,
        connectTaskStore: () =>
          Promise.resolve({
            close: () => Promise.resolve(),
            migrate: () => Promise.resolve(),
          }) as never,
        createHost: (options) => {
          ingress = options.v2Ingress;
          return Promise.resolve({
            close: () => ingress?.close() ?? Promise.resolve(),
          } as never);
        },
        createWorkflows: () => workflows,
      },
    });
    expect(service.readinessOutage()).toEqual({
      boundMs: 120_000,
      deferredDeliveries: 0,
      outageFailures: 0,
      recipientsDeferred: 0,
    });

    // A message whose first attempt failed and whose retry is now due.
    const input = {
      ...structuredClone(fixture.input),
      dedupeKey: "shared-outage",
      policy: POLICY,
    };
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      input.dedupeKey,
      "shared-outage-queue"
    );
    if (!ledger) {
      throw new Error("ledger was not connected");
    }
    await ledger.recordStartIntent(workflowId, scope, input);
    await workflows.start({
      input: { input, trustedScope: scope },
      requestId: "shared-outage:start",
      workflowId,
      workflowType: supervisorMessageV2WorkflowDefinition.type,
    });
    await workflows.signal({
      name: "delivery_failed",
      payload: { permanent: false, reason: "provider unavailable" },
      requestId: "shared-outage:first-attempt",
      workflowId,
    });
    clock += POLICY.retryDelayMs;

    // The governed claim path delivers the due retry: deferred.
    const governance = service.governance;
    if (!governance) {
      throw new Error("governance is not configured");
    }
    await expect(
      governance.claim({
        claimant: input.to,
        requestId: "shared-outage:claim",
        trustedScope: scope,
        workflowId,
      })
    ).rejects.toBeInstanceOf(WorkflowError);
    // The ingress recovery path delivers the still-pending message: deferred.
    await ingress?.start();

    expect(service.readinessOutage()).toEqual({
      boundMs: 120_000,
      deferredDeliveries: 2,
      outageFailures: 0,
      recipientsDeferred: 1,
    });
    // The control principal's status names the recipient, on the service's
    // own clock, as the count does.
    const status = await service.assignmentRoute?.httpHandler(
      new Request("http://local/assignment", {
        headers: { authorization: "Bearer outage-control" },
      })
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({
      readinessOutage: [input.to],
    });
    // One recipient, one outage: logged once across both paths.
    expect(
      errors.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("V2 delivery to "))
    ).toEqual([
      `V2 delivery to ${input.to} deferred: session readiness store is unavailable`,
    ]);
    expect(
      (
        await workflows.query({
          args: { trustedScope: scope },
          name: "status",
          workflowId,
        })
      ).value
    ).toMatchObject({ deliveryAttempts: 1, phase: "routed" });
  } finally {
    errors.mockRestore();
    await service?.close().catch(() => undefined);
    await postgres?.close();
  }
}, 120_000);

test("every V2 delivery path of one service defers a not-enrolled recipient under one shared bound, log line, and counters", async () => {
  const [fixture] = supervisorMessageV2ReplayFixtures;
  if (!fixture) {
    throw new Error("missing V2 fixture");
  }
  const scope = fixture.expectedScope;
  let clock = Date.parse(NOW);
  const now = () => new Date(clock).toISOString();
  const workflows = new InMemoryWorkflowPort({
    definitions: [supervisorMessageV2WorkflowDefinition],
    now,
  });
  const recipient = fixture.input.to;
  // The host's enrollment found the recipient's seat down a second ago.
  const downSince = clock - 1000;
  let ingress: SupervisorA2AV2IngressLifecycle | undefined;
  let postgres: DisposablePostgres | undefined;
  let service: SupervisorA2AV2Service | undefined;
  let ledger: PostgresSupervisorMessageV2DeliveryLedger | undefined;
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    postgres = await DisposablePostgres.create();
    const databaseUrl = postgres.databaseUrl();
    service = await createSupervisorA2AV2Service({
      card: {
        description: "shared not-enrolled deferral",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      databaseUrl,
      delivery: {
        deliver: () => Promise.reject(new Error("not enrolled: no delivery")),
      },
      dispatchOwner: "v2-dispatcher:shared-not-enrolled",
      host: { taskQueue: "shared-not-enrolled-queue" } as never,
      messageAuthority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:test",
          reasonCode: "allowed",
        }),
      },
      notEnrolledBoundMs: 120_000,
      now,
      peerRoutes: [{ pathname: "/a2a/seats/peer", supervisorId: PEER }],
      policy: POLICY,
      providerReadiness: { ready: () => ({}) as never },
      rebindAuthority: {
        decide: () => ({
          allowed: false,
          authorityRef: "authority:none",
          reasonCode: "denied",
        }),
      },
      recipientEnrollment: {
        notEnrolled: () => [recipient],
        notEnrolledSince: (seat) =>
          seat === recipient ? downSince : undefined,
      },
      route: {
        authenticator: { authenticate: () => undefined },
        tenant: scope.tenantId,
      },
      supervisorId: RECIPIENT,
      dependencies: {
        connectLedger: async (url, options) => {
          ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
            url,
            options
          );
          return ledger;
        },
        connectSessions: () =>
          Promise.resolve({
            // The store answers: the recipient has no current descriptor.
            assertReady: () =>
              Promise.reject(
                new SupervisorSessionV2Error(
                  "current session descriptor is absent"
                )
              ),
            close: () => Promise.resolve(),
            current: () => Promise.resolve(undefined),
            migrate: () => Promise.resolve(),
            rebind: () => Promise.reject(new Error("unused")),
            register: () => Promise.reject(new Error("unused")),
            status: () => Promise.reject(new Error("unused")),
          }) as never,
        connectTaskStore: () =>
          Promise.resolve({
            close: () => Promise.resolve(),
            migrate: () => Promise.resolve(),
          }) as never,
        createHost: (options) => {
          ingress = options.v2Ingress;
          return Promise.resolve({
            close: () => ingress?.close() ?? Promise.resolve(),
          } as never);
        },
        createWorkflows: () => workflows,
      },
    });
    expect(service.notEnrolledDeferral()).toEqual({
      boundMs: 120_000,
      deferredDeliveries: 0,
      notEnrolledFailures: 0,
      recipientsDeferred: 0,
    });

    // A message whose first attempt failed and whose retry is now due.
    const input = {
      ...structuredClone(fixture.input),
      dedupeKey: "shared-not-enrolled",
      policy: POLICY,
    };
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      input.dedupeKey,
      "shared-not-enrolled-queue"
    );
    if (!ledger) {
      throw new Error("ledger was not connected");
    }
    await ledger.recordStartIntent(workflowId, scope, input);
    await workflows.start({
      input: { input, trustedScope: scope },
      requestId: "shared-not-enrolled:start",
      workflowId,
      workflowType: supervisorMessageV2WorkflowDefinition.type,
    });
    await workflows.signal({
      name: "delivery_failed",
      payload: { permanent: false, reason: "provider unavailable" },
      requestId: "shared-not-enrolled:first-attempt",
      workflowId,
    });
    clock += POLICY.retryDelayMs;

    // The governed claim path delivers the due retry: deferred.
    const governance = service.governance;
    if (!governance) {
      throw new Error("governance is not configured");
    }
    await expect(
      governance.claim({
        claimant: input.to,
        requestId: "shared-not-enrolled:claim",
        trustedScope: scope,
        workflowId,
      })
    ).rejects.toBeInstanceOf(WorkflowError);
    // The ingress recovery path delivers the still-pending message: deferred.
    await ingress?.start();

    expect(service.notEnrolledDeferral()).toEqual({
      boundMs: 120_000,
      deferredDeliveries: 2,
      notEnrolledFailures: 0,
      recipientsDeferred: 1,
    });
    // The readiness store answered, so this is no readiness outage.
    expect(service.readinessOutage()).toMatchObject({
      deferredDeliveries: 0,
      recipientsDeferred: 0,
    });
    // One recipient, one spell: logged once across both paths.
    expect(
      errors.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("V2 delivery to "))
    ).toEqual([
      `V2 delivery to ${input.to} deferred: recipient session is not enrolled`,
    ]);
    // The deferrals spent no attempt: only the first, failed one counts.
    expect(
      (
        await workflows.query({
          args: { trustedScope: scope },
          name: "status",
          workflowId,
        })
      ).value
    ).toMatchObject({ deliveryAttempts: 1, phase: "routed" });
  } finally {
    errors.mockRestore();
    await service?.close().catch(() => undefined);
    await postgres?.close();
  }
}, 120_000);

test("a stopped PostgreSQL session store defers a delivery with one log line until the outage bound, then fails it as a retryable attempt", async () => {
  const [fixture] = supervisorMessageV2ReplayFixtures;
  if (!fixture) {
    throw new Error("missing V2 fixture");
  }
  const scope = fixture.expectedScope;
  let clock = Date.parse(NOW);
  let sessionsDb: DisposablePostgres | undefined;
  let ledgerDb: DisposablePostgres | undefined;
  let sessions: PostgresSupervisorSessionV2Store | undefined;
  let ledger: PostgresSupervisorMessageV2DeliveryLedger | undefined;
  try {
    [sessionsDb, ledgerDb] = await Promise.all([
      DisposablePostgres.create(),
      DisposablePostgres.create(),
    ]);
    sessions = await PostgresSupervisorSessionV2Store.connect({
      authority: {
        decide: () => ({
          allowed: false,
          authorityRef: "authority:none",
          reasonCode: "denied",
        }),
      },
      databaseUrl: sessionsDb.databaseUrl(),
      now: () => new Date(clock).toISOString(),
      provider: { ready: () => ({}) as never },
    });
    await sessions.migrate();
    ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      ledgerDb.databaseUrl(),
      { deployment: "stopped-session-store-queue" }
    );
    await ledger.migrate();
    const lines: string[] = [];
    const outage = new SupervisorMessageV2ReadinessOutageTracker({
      boundMs: 60_000,
      log: (line) => lines.push(line),
    });
    const delivered: string[] = [];
    const coordinator = new SupervisorMessageV2Coordinator(
      new InMemoryWorkflowPort({
        definitions: [supervisorMessageV2WorkflowDefinition],
        now: () => new Date(clock).toISOString(),
      }),
      {
        deliver: (envelope) => {
          delivered.push(envelope.deliveryId);
          return Promise.resolve({ status: "accepted" });
        },
      },
      ledger,
      "v2-dispatcher:stopped-session-store",
      () => new Date(clock),
      sessions,
      outage
    );

    // The session store's database goes away; the ledger's stays.
    await sessionsDb.close();
    sessionsDb = undefined;

    const input = {
      ...structuredClone(fixture.input),
      dedupeKey: "stopped-session-store",
      policy: POLICY,
    };
    const received = await coordinator.receive(
      scope,
      input,
      "request:stopped-session-store"
    );
    expect(received.projection).toMatchObject({
      deliveryAttempts: 0,
      phase: "routed",
    });
    expect(lines).toEqual([
      `V2 delivery to ${input.to} deferred: session readiness store is unavailable`,
    ]);

    clock += 60_000;
    expect(await coordinator.recoverPending()).toBe(1);
    expect(await coordinator.status(scope, received.workflowId)).toMatchObject({
      deliveryAttempts: 1,
      phase: "retry-scheduled",
    });
    expect(delivered).toEqual([]);
    expect(lines).toEqual([
      `V2 delivery to ${input.to} deferred: session readiness store is unavailable`,
      `V2 delivery to ${input.to} still deferred after 60000ms: the readiness store outage now fails delivery attempts`,
    ]);
    expect(outage.snapshot(new Date(clock))).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 1,
      outageFailures: 1,
      recipientsDeferred: 1,
    });
  } finally {
    await sessions?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    await sessionsDb?.close();
    await ledgerDb?.close();
  }
}, 120_000);

import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
import {
  createSupervisorA2AV2Service,
  type SupervisorA2AV2Service,
} from "../../src/loop/supervisor-a2a-v2-service";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { SupervisorMessageV2ReadinessUnavailableError } from "../../src/loop/supervisor-message-v2-runtime";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
} from "../../src/loop/supervisor-session-v2";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";

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
        taskQueue: "partial-cleanup",
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
          close: () => {
            closes.push("ledger");
            return Promise.resolve();
          },
          migrate: () =>
            Promise.reject(new Error("controlled second migration failure")),
        }) as never,
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
});

const BIND_MESSAGE = deriveSupervisorMessageV2WorkflowId(SCOPE, "bind");
const BIND_GRAPH = deriveSupervisorMessageV2ResultGraphWorkflowId(
  SCOPE,
  BIND_MESSAGE
);

test("result binding refuses a graph not derived from the message, or a graph task the host has not configured or that is another worker's, before the ledger records it", async () => {
  const bound: unknown[] = [];
  const queried: string[] = [];
  const closed = () => Promise.resolve();
  const create = (
    resultGraphTasks?: { graphTaskId: string; graphWorkflowId: string }[]
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
      resultGraphTasks,
      dependencies: {
        connectLedger: () =>
          Promise.resolve({
            bindResult: (_scope: unknown, binding: unknown) => {
              bound.push(binding);
              return Promise.resolve();
            },
            close: closed,
            migrate: closed,
          }) as never,
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
    await expect(unconfigured.bindResult(SCOPE, binding)).rejects.toThrow(
      "not configured"
    );
  } finally {
    await unconfigured.close();
  }
  // Graphs not derived from this message, even when the host allowlists
  // them: one the body names freely, and the one derived for the same
  // message id under another tenant.
  const otherTenantGraph = deriveSupervisorMessageV2ResultGraphWorkflowId(
    { ...SCOPE, tenantId: "tenant:v2-service-other" },
    BIND_MESSAGE
  );
  const service = await create([
    { graphWorkflowId: BIND_GRAPH, graphTaskId: "node:mine" },
    { graphWorkflowId: BIND_GRAPH, graphTaskId: "node:theirs" },
    { graphWorkflowId: "graph:chosen-by-body", graphTaskId: "node:mine" },
    { graphWorkflowId: otherTenantGraph, graphTaskId: "node:mine" },
  ]);
  try {
    await expect(
      service.bindResult(SCOPE, { ...binding, graphTaskId: "node:unlisted" })
    ).rejects.toThrow("not configured");
    for (const graphWorkflowId of ["graph:chosen-by-body", otherTenantGraph]) {
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
        postgres.databaseUrl()
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
      postgres.databaseUrl()
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

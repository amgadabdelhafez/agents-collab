import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type Task, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { SQL } from "bun";
import { PostgresA2ATaskStore } from "../../src/loop/a2a-postgres-task-store";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import type { SupervisorA2AResultBinding } from "../../src/loop/a2a-supervisor-result";
import {
  createSupervisorA2AV2Service,
  type SupervisorA2AV2Service,
} from "../../src/loop/supervisor-a2a-v2-service";
import {
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import type { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { DisposablePostgres } from "../support/disposable-postgres";

const fixture = supervisorMessageV2ReplayFixtures[0];
if (!fixture) {
  throw new Error("missing V2 input fixture");
}
const RECIPIENT = "supervisor:target";
const OTHER_WORKER = "supervisor:other-worker";
const NOW = "2026-10-05T12:00:00.000Z";
const ARTIFACT = `artifact://sha256/${"e".repeat(64)}`;
const POLICY = {
  claimTimeoutMs: 60_000,
  escalationTimeoutMs: 120_000,
  maxDeliveryAttempts: 3,
  retryDelayMs: 1000,
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );

/** The ledger's deployment discriminator: the host's task queue. */
const DEPLOYMENT = "result-binding";
let postgres: DisposablePostgres;
let raw: SQL;
let ledger: PostgresSupervisorMessageV2DeliveryLedger;
let tasks: PostgresA2ATaskStore;

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
  ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl(),
    { deployment: DEPLOYMENT }
  );
  tasks = await PostgresA2ATaskStore.connect({
    databaseUrl: postgres.databaseUrl(),
  });
  await tasks.migrate();
  await ledger.migrate();
}, 60_000);

afterAll(async () => {
  await tasks?.close();
  await ledger?.close();
  await raw?.close();
  await postgres?.close();
});

/** A fresh tenant per test, so tests sharing one database never collide. */
const tenant = (label: string): TrustedSupervisorMessageV2Scope => {
  const suffix = randomUUID().slice(0, 8);
  return {
    tenantId: `tenant:${label}-${suffix}`,
    principal: `principal:${label}-${suffix}`,
  };
};

const contextOf = (scope: TrustedSupervisorMessageV2Scope) =>
  new ServerCallContext({
    tenant: scope.tenantId,
    user: { isAuthenticated: true, userName: scope.principal },
  });

const inputFor = (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
): SupervisorMessageV2Input => ({
  ...structuredClone(fixture.input),
  dedupeKey,
  messageId: `message-${dedupeKey}`,
  principal: scope.principal,
  tenantId: scope.tenantId,
  threadId: `thread-${dedupeKey}`,
  to: RECIPIENT,
});

/** A durable start intent: the message every binding is checked against. */
const sendMessage = async (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
): Promise<string> => {
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    scope,
    dedupeKey,
    DEPLOYMENT
  );
  await ledger.recordStartIntent(workflowId, scope, inputFor(scope, dedupeKey));
  return workflowId;
};

const saveTask = async (
  scope: TrustedSupervisorMessageV2Scope,
  id: string,
  workflowIds: string[],
  state = TaskState.TASK_STATE_WORKING
): Promise<void> => {
  const task: Task = {
    id,
    contextId: `context:${id}`,
    history: [],
    artifacts: [],
    metadata: { [WORKFLOW_IDS_METADATA_KEY]: workflowIds },
    status: { state, timestamp: NOW, message: undefined },
  };
  await tasks.save(task, contextOf(scope));
};

const bindingFor = (
  scope: TrustedSupervisorMessageV2Scope,
  messageWorkflowId: string,
  a2aTaskId: string,
  graphTaskId = "result-node"
): SupervisorA2AResultBinding => ({
  a2aTaskId,
  graphTaskId,
  graphWorkflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
    scope,
    messageWorkflowId
  ),
  messageWorkflowId,
  recipient: RECIPIENT,
});

const reservationsFor = async (graphWorkflowId: string) =>
  (await raw`SELECT graph_task_id, tenant_id, a2a_task_id FROM loop_supervisor_message_v2_result_graph_task
    WHERE graph_workflow_id = ${graphWorkflowId} ORDER BY graph_task_id`) as {
    a2a_task_id: string;
    graph_task_id: string;
    tenant_id: string;
  }[];

const closed = () => Promise.resolve();

/** The real V2 service over the real PostgreSQL ledger and A2A task store.
 * Only Temporal is replaced: graph projections come from `graphs`. */
const serviceFor = (input: {
  scope: TrustedSupervisorMessageV2Scope;
  allow: { graphWorkflowId: string; graphTaskId: string }[];
  graphs: Map<string, { taskId: string; workerId: string; phase: string }[]>;
}): Promise<SupervisorA2AV2Service> =>
  createSupervisorA2AV2Service({
    ...({
      assignmentRoute: {
        pathname: "/assignment",
        principal: input.scope.principal,
      },
      card: {
        description: "result binding proof",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      databaseUrl: postgres.databaseUrl(),
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" as const }),
      },
      dispatchOwner: "v2-dispatcher:result-binding",
      host: {
        authority: {
          decide: () => ({
            allowed: true,
            authorityRef: "authority:test",
            reasonCode: "allowed",
          }),
        },
        buildId: "result-binding.v1",
        delivery: {
          deliver: () => Promise.resolve({ status: "accepted" as const }),
        },
        identity: "result-binding",
        namespace: "default",
        nativeConnection: {},
        receipts: { record: () => undefined },
        store: {} as JsonlSupervisorThreadStore,
        taskQueue: "result-binding",
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
            principal: input.scope.principal,
            supervisorId: "supervisor:sender",
          }),
        },
        tenant: input.scope.tenantId,
      },
      supervisorId: RECIPIENT,
    } as const),
    resultGraphTasks: input.allow,
    verifyResultArtifact: (reference, target) =>
      Promise.resolve(
        reference === ARTIFACT &&
          input.allow.some(
            (entry) =>
              entry.graphWorkflowId === target.graphWorkflowId &&
              entry.graphTaskId === target.graphTaskId
          )
      ),
    dependencies: {
      connectLedger: (databaseUrl, deployment) =>
        PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl, {
          deployment,
        }),
      connectTaskStore: (options) => PostgresA2ATaskStore.connect(options),
      connectSessions: () =>
        Promise.resolve({
          assertReady: closed,
          close: closed,
          migrate: closed,
        }) as never,
      createHost: () => Promise.resolve({ close: closed }) as never,
      createWorkflows: () =>
        ({
          query: (query: { workflowId: string }) => {
            const nodes = input.graphs.get(query.workflowId);
            if (!nodes) {
              return Promise.reject(new Error("no such graph"));
            }
            return Promise.resolve({
              revision: 1,
              status: "running",
              workflowId: query.workflowId,
              value: {
                schema: "task-graph-projection.v1",
                nodes: nodes.map((node) => ({
                  ...node,
                  acceptanceReceipts:
                    node.phase === "succeeded"
                      ? [{ checkId: "artifact", artifactRef: ARTIFACT }]
                      : [],
                })),
              },
            });
          },
        }) as never,
    },
  });

const assign = (
  service: SupervisorA2AV2Service,
  binding: SupervisorA2AResultBinding
) =>
  service.assignmentRoute?.httpHandler(
    new Request("http://local/assignment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(binding),
    })
  );

test("a body-supplied graph that is not derived from the message is refused, even when the host allowlists it", async () => {
  const scope = tenant("body-graph");
  const message = await sendMessage(scope, "body-graph");
  await saveTask(scope, "task:body-graph", [message]);
  const derived = bindingFor(scope, message, "task:body-graph");
  // The operator allowlisted an arbitrary graph, and the graph really does
  // hold this recipient's task: only the message-derived graph may be bound.
  const arbitrary = { ...derived, graphWorkflowId: "task-graph:arbitrary" };
  const graphs = new Map([
    [
      arbitrary.graphWorkflowId,
      [{ taskId: "result-node", workerId: RECIPIENT, phase: "running" }],
    ],
    [
      derived.graphWorkflowId,
      [{ taskId: "result-node", workerId: RECIPIENT, phase: "running" }],
    ],
  ]);
  const service = await serviceFor({
    scope,
    allow: [arbitrary, derived].map(({ graphWorkflowId, graphTaskId }) => ({
      graphWorkflowId,
      graphTaskId,
    })),
    graphs,
  });
  try {
    expect((await assign(service, arbitrary))?.status).toBe(409);
    await expect(service.bindResult(scope, arbitrary)).rejects.toThrow(
      "not derived from this message"
    );
    // The durable ledger refuses it on its own, not only the host check.
    await expect(ledger.bindResult(scope, arbitrary)).rejects.toThrow(
      "not derived from this message"
    );
    expect(await reservationsFor(arbitrary.graphWorkflowId)).toEqual([]);
    await expect(
      ledger.resultBinding(scope, message, "task:body-graph")
    ).resolves.toBeUndefined();
    expect((await assign(service, derived))?.status).toBe(200);
    await expect(
      ledger.resultBinding(scope, message, "task:body-graph")
    ).resolves.toEqual(derived);
  } finally {
    await service.close();
  }
});

test("a message cannot bind to the graph derived for another tenant's message", async () => {
  const mine = tenant("cross-mine");
  const theirs = tenant("cross-theirs");
  const myMessage = await sendMessage(mine, "cross-tenant");
  // Same dedupe key in another tenant: a different message and graph.
  const theirMessage = await sendMessage(theirs, "cross-tenant");
  expect(theirMessage).not.toBe(myMessage);
  await saveTask(mine, "task:cross-mine", [myMessage]);
  await saveTask(theirs, "task:cross-theirs", [theirMessage]);
  const theirBinding = bindingFor(theirs, theirMessage, "task:cross-theirs");
  const crossing = {
    ...bindingFor(mine, myMessage, "task:cross-mine"),
    graphWorkflowId: theirBinding.graphWorkflowId,
  };
  const service = await serviceFor({
    scope: mine,
    allow: [crossing].map(({ graphWorkflowId, graphTaskId }) => ({
      graphWorkflowId,
      graphTaskId,
    })),
    graphs: new Map([
      [
        theirBinding.graphWorkflowId,
        [{ taskId: "result-node", workerId: RECIPIENT, phase: "running" }],
      ],
    ]),
  });
  try {
    expect((await assign(service, crossing))?.status).toBe(409);
    await expect(service.bindResult(mine, crossing)).rejects.toThrow(
      "not derived from this message"
    );
    await expect(ledger.bindResult(mine, crossing)).rejects.toThrow(
      "not derived from this message"
    );
    // Their own message is not bindable from my scope either.
    await expect(ledger.bindResult(mine, theirBinding)).rejects.toThrow();
    expect(await reservationsFor(theirBinding.graphWorkflowId)).toEqual([]);
    // The owner still binds its own graph task.
    await ledger.bindResult(theirs, theirBinding);
    expect(await reservationsFor(theirBinding.graphWorkflowId)).toEqual([
      {
        graph_task_id: "result-node",
        tenant_id: theirs.tenantId,
        a2a_task_id: "task:cross-theirs",
      },
    ]);
  } finally {
    await service.close();
  }
});

test("a refused bind rolls back the reservation it made, and a live A2A task keeps its graph task", async () => {
  const scope = tenant("reserve");
  const message = await sendMessage(scope, "reserve");
  await saveTask(scope, "task:reserve-one", [message]);
  await saveTask(scope, "task:reserve-two", [message]);
  const first = bindingFor(scope, message, "task:reserve-one");
  await ledger.bindResult(scope, first);
  // Same A2A task, another graph task: the binding is immutable, and the
  // reservation the refused call inserted is rolled back with it.
  await expect(
    ledger.bindResult(scope, { ...first, graphTaskId: "second-node" })
  ).rejects.toThrow("conflicts with prior assignment");
  expect(
    (await reservationsFor(first.graphWorkflowId)).map(
      (row) => row.graph_task_id
    )
  ).toEqual(["result-node"]);
  // Another A2A task carrying the same message cannot take the graph task
  // while its holder is live, and leaves no binding behind.
  const second = { ...first, a2aTaskId: "task:reserve-two" };
  await expect(ledger.bindResult(scope, second)).rejects.toThrow(
    "reserved for another A2A task"
  );
  await expect(
    ledger.bindResult(scope, second, {
      releasable: () => Promise.resolve(false),
    })
  ).rejects.toThrow("reserved for another A2A task");
  await expect(
    ledger.resultBinding(scope, message, "task:reserve-two")
  ).resolves.toBeUndefined();
  await expect(
    ledger.resultBinding(scope, message, "task:reserve-one")
  ).resolves.toEqual(first);
});

for (const state of [
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_FAILED,
]) {
  test(`a graph-task reservation is released once its A2A task is ${TaskState[state]}`, async () => {
    const scope = tenant(`release-${state}`);
    const message = await sendMessage(scope, "release");
    await saveTask(scope, "task:release-one", [message]);
    await saveTask(scope, "task:release-two", [message]);
    const first = bindingFor(scope, message, "task:release-one");
    const second = { ...first, a2aTaskId: "task:release-two" };
    const service = await serviceFor({
      scope,
      allow: [first].map(({ graphWorkflowId, graphTaskId }) => ({
        graphWorkflowId,
        graphTaskId,
      })),
      graphs: new Map([
        [
          first.graphWorkflowId,
          [{ taskId: "result-node", workerId: RECIPIENT, phase: "succeeded" }],
        ],
      ]),
    });
    try {
      await service.bindResult(scope, first);
      await expect(service.bindResult(scope, second)).rejects.toThrow(
        "reserved for another A2A task"
      );
      await saveTask(scope, "task:release-one", [message], state);
      await service.bindResult(scope, second);
      expect(await reservationsFor(first.graphWorkflowId)).toEqual([
        {
          graph_task_id: "result-node",
          tenant_id: scope.tenantId,
          a2a_task_id: "task:release-two",
        },
      ]);
      // The ended task's binding no longer holds the graph task and is never
      // published; the new holder completes with it.
      await expect(
        ledger.resultBinding(scope, message, "task:release-one")
      ).resolves.toBeUndefined();
      await service.publishResult(scope, {
        workflowId: message,
        taskId: "task:release-two",
        recipient: RECIPIENT,
      });
      expect(
        (await tasks.load("task:release-two", contextOf(scope)))?.status?.state
      ).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      await service.close();
    }
  });
}

test("follow-up turns of one A2A task each bind their own message graph and complete the task together", async () => {
  const scope = tenant("follow-up");
  const turnOne = await sendMessage(scope, "follow-up-one");
  const turnTwo = await sendMessage(scope, "follow-up-two");
  await saveTask(scope, "task:follow-up", [turnOne, turnTwo]);
  const one = bindingFor(scope, turnOne, "task:follow-up");
  const two = bindingFor(scope, turnTwo, "task:follow-up");
  expect(two.graphWorkflowId).not.toBe(one.graphWorkflowId);
  const graphs = new Map([
    [
      one.graphWorkflowId,
      [{ taskId: "result-node", workerId: RECIPIENT, phase: "succeeded" }],
    ],
    [
      two.graphWorkflowId,
      [
        { taskId: "result-node", workerId: RECIPIENT, phase: "running" },
        { taskId: "theirs", workerId: OTHER_WORKER, phase: "running" },
      ],
    ],
  ]);
  const service = await serviceFor({
    scope,
    allow: [one, two].map(({ graphWorkflowId, graphTaskId }) => ({
      graphWorkflowId,
      graphTaskId,
    })),
    graphs,
  });
  try {
    expect((await assign(service, one))?.status).toBe(200);
    expect((await assign(service, two))?.status).toBe(200);
    const publish = (workflowId: string) =>
      service.publishResult(scope, {
        workflowId,
        taskId: "task:follow-up",
        recipient: RECIPIENT,
      });
    await publish(turnOne);
    expect(
      (await tasks.load("task:follow-up", contextOf(scope)))?.status?.state
    ).toBe(TaskState.TASK_STATE_WORKING);
    await expect(publish(turnTwo)).rejects.toThrow("not accepted");
    graphs.set(two.graphWorkflowId, [
      { taskId: "result-node", workerId: RECIPIENT, phase: "succeeded" },
    ]);
    await publish(turnTwo);
    const completed = await tasks.load("task:follow-up", contextOf(scope));
    expect(completed?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(
      completed?.artifacts.map((artifact) => artifact.artifactId).sort()
    ).toEqual([`accepted:${turnOne}`, `accepted:${turnTwo}`].sort());
  } finally {
    await service.close();
  }
});

test("migration backfills reservations for existing derived bindings and never publishes a body-chosen one", async () => {
  // A database as the base revision left it: the three original tables and
  // bindings written exactly as its bindResult wrote them. No reservations.
  const isolated = await DisposablePostgres.create();
  const legacy = new SQL(isolated.databaseUrl());
  const upgraded = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    isolated.databaseUrl(),
    { deployment: DEPLOYMENT }
  );
  try {
    await legacy.connect();
    await legacy`CREATE TABLE loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
    await legacy`CREATE TABLE loop_supervisor_message_v2_result_binding (
      workflow_id TEXT NOT NULL REFERENCES loop_supervisor_message_v2_start_intent(workflow_id),
      a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
      binding_json JSONB NOT NULL, PRIMARY KEY (workflow_id, a2a_task_id)
    )`;
    const scope = tenant("backfill");
    // Start intents as the base revision wrote them: the legacy workflow id
    // and no deployment column. Their bindings must keep working.
    const seed = async (dedupeKey: string) => {
      const workflowId = deriveSupervisorMessageV2LegacyWorkflowId(
        scope,
        dedupeKey
      );
      await legacy`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json)
        VALUES (${workflowId}, ${scope.tenantId}, ${scope.principal}, ${canonical(inputFor(scope, dedupeKey))}::jsonb)`;
      return workflowId;
    };
    const derivedMessage = await seed("backfill-derived");
    const bodyMessage = await seed("backfill-body");
    const objectMessage = await seed("backfill-object");
    const derived = bindingFor(scope, derivedMessage, "task:backfill-derived");
    const bodyChosen = {
      ...bindingFor(scope, bodyMessage, "task:backfill-body"),
      graphWorkflowId: "task-graph:chosen-by-body",
    };
    // A second body-chosen binding, which no earlier revision reserved.
    const unreservedBodyChosen = {
      ...bindingFor(scope, await seed("backfill-body-two"), "task:body-two"),
      graphWorkflowId: "task-graph:also-chosen-by-body",
    };
    const objectForm = bindingFor(scope, objectMessage, "task:backfill-object");
    for (const binding of [derived, bodyChosen, unreservedBodyChosen]) {
      await legacy`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
        VALUES (${binding.messageWorkflowId}, ${binding.a2aTaskId}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)`;
    }
    // This is the encoding the base revision produced: a JSON string, which
    // `->>` cannot read (the reason an earlier SQL backfill failed).
    expect(
      (await legacy`SELECT jsonb_typeof(binding_json) AS kind FROM loop_supervisor_message_v2_result_binding`) as {
        kind: string;
      }[]
    ).toEqual([{ kind: "string" }, { kind: "string" }, { kind: "string" }]);
    // The same binding stored as a JSON object rather than a JSON string.
    await legacy`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${objectForm.messageWorkflowId}, ${objectForm.a2aTaskId}, ${scope.tenantId}, ${scope.principal},
        jsonb_build_object('a2aTaskId', ${objectForm.a2aTaskId}::text, 'graphTaskId', ${objectForm.graphTaskId}::text,
          'graphWorkflowId', ${objectForm.graphWorkflowId}::text, 'messageWorkflowId', ${objectForm.messageWorkflowId}::text,
          'recipient', ${objectForm.recipient}::text))`;
    // Malformed legacy content must not stop the host from starting.
    const brokenMessage = await seed("backfill-broken");
    await legacy`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${brokenMessage}, ${"task:backfill-broken"}, ${scope.tenantId}, ${scope.principal}, ${'{"unexpected":true}'}::jsonb)`;
    // The rejected 52113358 revision reserved whatever graph the body named.
    // Such a reservation must not make a body-chosen binding publishable.
    await legacy`CREATE TABLE loop_supervisor_message_v2_result_graph_task (
      graph_workflow_id TEXT NOT NULL, graph_task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL,
      PRIMARY KEY (graph_workflow_id, graph_task_id)
    )`;
    await legacy`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
      VALUES (${bodyChosen.graphWorkflowId}, ${bodyChosen.graphTaskId}, ${scope.tenantId}, ${bodyChosen.a2aTaskId})`;

    // Migrating twice is how every restart runs it.
    await upgraded.migrate();
    await upgraded.migrate();
    const reserved =
      (await legacy`SELECT graph_workflow_id, graph_task_id, a2a_task_id FROM loop_supervisor_message_v2_result_graph_task ORDER BY a2a_task_id`) as {
        a2a_task_id: string;
        graph_task_id: string;
        graph_workflow_id: string;
      }[];
    expect(reserved).toEqual([
      {
        graph_workflow_id: bodyChosen.graphWorkflowId,
        graph_task_id: "result-node",
        a2a_task_id: "task:backfill-body",
      },
      {
        graph_workflow_id: derived.graphWorkflowId,
        graph_task_id: "result-node",
        a2a_task_id: "task:backfill-derived",
      },
      {
        graph_workflow_id: objectForm.graphWorkflowId,
        graph_task_id: "result-node",
        a2a_task_id: "task:backfill-object",
      },
    ]);
    await expect(
      upgraded.resultBinding(scope, derivedMessage, "task:backfill-derived")
    ).resolves.toEqual(derived);
    await expect(
      upgraded.resultBinding(scope, objectMessage, "task:backfill-object")
    ).resolves.toEqual(objectForm);
    // A graph the request body chose is never published ...
    await expect(
      upgraded.resultBinding(scope, bodyMessage, "task:backfill-body")
    ).resolves.toBeUndefined();
    await expect(
      upgraded.resultBinding(
        scope,
        unreservedBodyChosen.messageWorkflowId,
        "task:body-two"
      )
    ).resolves.toBeUndefined();
    // ... and the message can be re-bound to its own derived graph.
    const rebound = bindingFor(scope, bodyMessage, "task:backfill-body");
    await upgraded.bindResult(scope, rebound);
    await expect(
      upgraded.resultBinding(scope, bodyMessage, "task:backfill-body")
    ).resolves.toEqual(rebound);
    // A derived binding stays immutable.
    await expect(
      upgraded.bindResult(scope, { ...derived, graphTaskId: "second-node" })
    ).rejects.toThrow("conflicts with prior assignment");
  } finally {
    await upgraded.close();
    await legacy.close();
    await isolated.close();
  }
}, 60_000);

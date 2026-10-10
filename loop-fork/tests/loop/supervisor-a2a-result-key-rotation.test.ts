import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { type Task, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { SQL } from "bun";
import { PostgresA2ATaskStore } from "../../src/loop/a2a-postgres-task-store";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import {
  acceptedResultArtifactId,
  type SupervisorA2AResultBinding,
} from "../../src/loop/a2a-supervisor-result";
import {
  createSupervisorA2AV2Service,
  type SupervisorA2AV2Service,
} from "../../src/loop/supervisor-a2a-v2-service";
import {
  deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  type SupervisorMessageV2Input,
  SupervisorResultGraphKey,
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
const NOW = "2026-10-05T12:00:00.000Z";
const ARTIFACT = `artifact://sha256/${"e".repeat(64)}`;
const DEPLOYMENT = "key-rotation";
const BUILD_ID = "key-rotation.v1";
/** Throwaway host secrets, generated per run and never printed. */
const throwawayKey = () =>
  SupervisorResultGraphKey.fromSecret(randomBytes(32).toString("hex"));
const OLD_KEY = throwawayKey();
const NEW_KEY = throwawayKey();
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

let postgres: DisposablePostgres;
let raw: SQL;
let tasks: PostgresA2ATaskStore;
const opened: { close(): Promise<void> }[] = [];

/** A migrated ledger of one deployment (the host's task queue). */
const deploymentLedger = async (input: {
  databaseUrl?: string;
  deployment?: string;
  previousResultGraphKeys?: SupervisorResultGraphKey[];
  resultGraphKey: SupervisorResultGraphKey | undefined;
  workflowIdFormat?: "deployment" | "legacy";
}): Promise<PostgresSupervisorMessageV2DeliveryLedger> => {
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    input.databaseUrl ?? postgres.databaseUrl(),
    {
      buildId: BUILD_ID,
      deployment: input.deployment ?? DEPLOYMENT,
      ...(input.resultGraphKey ? { resultGraphKey: input.resultGraphKey } : {}),
      previousResultGraphKeys: input.previousResultGraphKeys ?? [],
      workflowIdFormat: input.workflowIdFormat ?? "deployment",
    }
  );
  opened.push(ledger);
  await ledger.migrate();
  return ledger;
};

const ledgerWith = (
  resultGraphKey: SupervisorResultGraphKey | undefined,
  previousResultGraphKeys: SupervisorResultGraphKey[] = [],
  databaseUrl = postgres.databaseUrl()
): Promise<PostgresSupervisorMessageV2DeliveryLedger> =>
  deploymentLedger({ databaseUrl, previousResultGraphKeys, resultGraphKey });

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
  tasks = await PostgresA2ATaskStore.connect({
    databaseUrl: postgres.databaseUrl(),
  });
  await tasks.migrate();
}, 60_000);

/** Each test's ledgers and services are closed when it ends, so the shared
 * database never runs out of connections. */
afterEach(async () => {
  for (const resource of opened.splice(0)) {
    await resource.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await tasks?.close();
  await raw?.close();
  await postgres?.close();
});

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

const sendMessage = async (
  ledger: PostgresSupervisorMessageV2DeliveryLedger,
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
): Promise<string> => {
  // The id of the ledger's deployment and workflow id format.
  const workflowId = await ledger.workflowIdFor(scope, dedupeKey);
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
    status: {
      state,
      timestamp: NOW,
      message: undefined,
    },
  };
  await tasks.save(task, contextOf(scope));
};

const bindingUnder = (
  key: SupervisorResultGraphKey,
  scope: TrustedSupervisorMessageV2Scope,
  messageWorkflowId: string,
  a2aTaskId: string
): SupervisorA2AResultBinding => ({
  a2aTaskId,
  graphTaskId: "result-node",
  graphWorkflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
    key,
    scope,
    messageWorkflowId
  ),
  messageWorkflowId,
  recipient: RECIPIENT,
});

const fingerprintOf = async (workflowId: string, a2aTaskId: string) =>
  (
    (await raw`SELECT result_graph_key_fingerprint AS fingerprint FROM loop_supervisor_message_v2_result_binding
      WHERE workflow_id = ${workflowId} AND a2a_task_id = ${a2aTaskId}`) as {
      fingerprint: string | null;
    }[]
  )[0]?.fingerprint;

const closed = () => Promise.resolve();

/** A Bun SQL query is a lazy thenable that `expect().rejects` never runs;
 * this awaits it inside a real promise. */
const run = async (query: PromiseLike<unknown>): Promise<unknown> =>
  await query;

/** The real V2 service over the real PostgreSQL ledger and A2A task store.
 * Only Temporal is replaced: every allowlisted graph task has succeeded. */
const serviceFor = async (input: {
  scope: TrustedSupervisorMessageV2Scope;
  allow: { graphWorkflowId: string; graphTaskId: string }[];
  resultGraphKey: SupervisorResultGraphKey | undefined;
  previousResultGraphKeys?: SupervisorResultGraphKey[];
  databaseUrl?: string;
  deployment?: string;
  log?: (line: string) => void;
  /** While `failing` is set, every A2A task read of the service rejects. */
  taskReads?: { failing: boolean };
  workflowIdFormat?: "deployment" | "legacy";
}): Promise<SupervisorA2AV2Service> => {
  const service = await createSupervisorA2AV2Service({
    ...({
      assignmentRoute: {
        pathname: "/assignment",
        principal: input.scope.principal,
      },
      card: {
        description: "key rotation proof",
        supervisorId: RECIPIENT,
        url: "http://a2a.local/a2a",
      },
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" as const }),
      },
      dispatchOwner: "v2-dispatcher:key-rotation",
      host: {
        authority: {
          decide: () => ({
            allowed: true,
            authorityRef: "authority:test",
            reasonCode: "allowed",
          }),
        },
        buildId: "key-rotation.v1",
        delivery: {
          deliver: () => Promise.resolve({ status: "accepted" as const }),
        },
        identity: "key-rotation",
        namespace: "default",
        nativeConnection: {},
        receipts: { record: () => undefined },
        store: {} as JsonlSupervisorThreadStore,
        taskQueue: input.deployment ?? DEPLOYMENT,
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
    databaseUrl: input.databaseUrl ?? postgres.databaseUrl(),
    log: input.log ?? (() => undefined),
    resultGraphKey: input.resultGraphKey,
    previousResultGraphKeys: input.previousResultGraphKeys,
    resultGraphTasks: input.allow,
    workflowIdFormat: input.workflowIdFormat ?? "deployment",
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
      connectLedger: (databaseUrl, options) =>
        PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl, options),
      connectTaskStore: async (options) => {
        const store = await PostgresA2ATaskStore.connect(options);
        const reads = input.taskReads;
        if (!reads) {
          return store;
        }
        // The real store, except that a read rejects while reads fail.
        return new Proxy(store, {
          get: (target, property) => {
            if (property === "load") {
              return (...args: Parameters<PostgresA2ATaskStore["load"]>) =>
                reads.failing
                  ? Promise.reject(new Error("A2A task store unavailable"))
                  : target.load(...args);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      connectSessions: () =>
        Promise.resolve({
          assertReady: closed,
          close: closed,
          migrate: closed,
        }) as never,
      createHost: () => Promise.resolve({ close: closed }) as never,
      createWorkflows: () =>
        ({
          query: (query: { workflowId: string }) =>
            input.allow.some(
              (entry) => entry.graphWorkflowId === query.workflowId
            )
              ? Promise.resolve({
                  revision: 1,
                  status: "running",
                  workflowId: query.workflowId,
                  value: {
                    schema: "task-graph-projection.v1",
                    nodes: [
                      {
                        taskId: "result-node",
                        workerId: RECIPIENT,
                        phase: "succeeded",
                        acceptanceReceipts: [
                          { checkId: "artifact", artifactRef: ARTIFACT },
                        ],
                      },
                    ],
                  },
                })
              : Promise.reject(new Error("no such graph")),
        }) as never,
    },
  });
  opened.push(service);
  return service;
};

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

const assignmentStatus = async (service: SupervisorA2AV2Service) => {
  const response = await service.assignmentRoute?.httpHandler(
    new Request("http://local/assignment", { method: "GET" })
  );
  expect(response?.status).toBe(200);
  const { notEnrolled, readinessOutage, recoveryQuarantine, ...rest } =
    (await response?.json()) as {
      notEnrolled: unknown[];
      readinessOutage: unknown[];
      recoveryQuarantine: unknown[];
      schema: string;
      underPreviousResultGraphKey: unknown[];
      unpublishable: unknown[];
    };
  // The sections the round-5 base adds are empty in every test here.
  expect({ notEnrolled, readinessOutage, recoveryQuarantine }).toEqual({
    notEnrolled: [],
    readinessOutage: [],
    recoveryQuarantine: [],
  });
  return rest;
};

const unknownKeyError = (fingerprint: string) =>
  `Result binding was derived under result graph key ${fingerprint}, which this host does not hold: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs`;

/** The refusal of a new binding naming a graph derived under a key that is
 * now a previous key: nothing new is ever bound under one. */
const previousKeyRefusal = (fingerprint: string) =>
  `Result graph was derived under previous result graph key ${fingerprint}, and new bindings use the primary key only: start this message's result graph again under the primary key and bind that graph`;

test("after a key rotation a binding made under the previous key still publishes, new binds use the new key, and the assignment listing names the previous-key bindings", async () => {
  const scope = tenant("rotate");
  const before = await ledgerWith(OLD_KEY);
  const oldMessage = await sendMessage(before, scope, "rotate-old");
  await saveTask(scope, "task:rotate-old", [oldMessage]);
  const oldBinding = bindingUnder(
    OLD_KEY,
    scope,
    oldMessage,
    "task:rotate-old"
  );
  await before.bindResult(scope, oldBinding);
  // The key a binding was derived under is recorded with it, by fingerprint.
  expect(await fingerprintOf(oldMessage, "task:rotate-old")).toBe(
    OLD_KEY.fingerprint
  );

  // Rotate: the new key is primary, the old one previous.
  const newMessage = await sendMessage(before, scope, "rotate-new");
  await saveTask(scope, "task:rotate-new", [newMessage]);
  const newBinding = bindingUnder(
    NEW_KEY,
    scope,
    newMessage,
    "task:rotate-new"
  );
  const service = await serviceFor({
    scope,
    allow: [oldBinding, newBinding].map(({ graphWorkflowId }) => ({
      graphWorkflowId,
      graphTaskId: "result-node",
    })),
    resultGraphKey: NEW_KEY,
    previousResultGraphKeys: [OLD_KEY],
  });
  const after = await ledgerWith(NEW_KEY, [OLD_KEY]);
  await expect(
    after.resultBinding(scope, oldMessage, "task:rotate-old")
  ).resolves.toEqual(oldBinding);
  // Until it publishes, the authenticated listing names the binding under
  // the previous key: removing that key now would strand it.
  const underOld = {
    a2aTaskId: "task:rotate-old",
    graphTaskId: "result-node",
    graphWorkflowId: oldBinding.graphWorkflowId,
    keyFingerprint: OLD_KEY.fingerprint,
    messageWorkflowId: oldMessage,
  };
  expect(await assignmentStatus(service)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [underOld],
    unpublishable: [],
  });
  expect(await after.previousKeyResultBindings(scope.tenantId)).toEqual([
    { ...underOld, tenantId: scope.tenantId },
  ]);
  await service.publishResult(scope, {
    workflowId: oldMessage,
    taskId: "task:rotate-old",
    recipient: RECIPIENT,
  });
  expect(
    (await tasks.load("task:rotate-old", contextOf(scope)))?.status?.state
  ).toBe(TaskState.TASK_STATE_COMPLETED);

  // A new bind is derived under the primary key only.
  const newUnderOld = bindingUnder(
    OLD_KEY,
    scope,
    newMessage,
    "task:rotate-new"
  );
  expect((await assign(service, newUnderOld))?.status).toBe(409);
  await expect(after.bindResult(scope, newUnderOld)).rejects.toThrow(
    previousKeyRefusal(OLD_KEY.fingerprint)
  );
  expect((await assign(service, newBinding))?.status).toBe(200);
  expect(await fingerprintOf(newMessage, "task:rotate-new")).toBe(
    NEW_KEY.fingerprint
  );
  // A binding recorded under the previous key stays immutable.
  await expect(
    after.bindResult(
      scope,
      bindingUnder(NEW_KEY, scope, oldMessage, "task:rotate-old")
    )
  ).rejects.toThrow("conflicts with prior assignment");

  // Published, the binding has settled: it no longer needs the previous key,
  // so the host's listing drops it. The ledger alone still classifies it.
  expect(await assignmentStatus(service)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [],
    unpublishable: [],
  });
  expect(await after.previousKeyResultBindings(scope.tenantId)).toEqual([
    { ...underOld, tenantId: scope.tenantId },
  ]);
}, 60_000);

test("a binding whose key was removed is reported unpublishable by fingerprint and refused exactly, not left silently stuck, and publishes again once the key is restored", async () => {
  const scope = tenant("removed");
  const removedKey = throwawayKey();
  const before = await ledgerWith(removedKey);
  const message = await sendMessage(before, scope, "removed");
  await saveTask(scope, "task:removed", [message]);
  const binding = bindingUnder(removedKey, scope, message, "task:removed");
  await before.bindResult(scope, binding);

  const lines: string[] = [];
  const service = await serviceFor({
    scope,
    allow: [
      { graphWorkflowId: binding.graphWorkflowId, graphTaskId: "result-node" },
    ],
    resultGraphKey: NEW_KEY,
    log: (line) => lines.push(line),
  });
  const without = await ledgerWith(NEW_KEY);
  const refusal = unknownKeyError(removedKey.fingerprint);
  // Publishing refuses with the exact error, naming the key by fingerprint.
  await expect(
    without.resultBinding(scope, message, "task:removed")
  ).rejects.toThrow(refusal);
  await expect(
    service.publishResult(scope, {
      workflowId: message,
      taskId: "task:removed",
      recipient: RECIPIENT,
    })
  ).rejects.toThrow(refusal);
  // A re-bind neither overwrites it nor reports it as a conflict.
  await expect(
    without.bindResult(
      scope,
      bindingUnder(NEW_KEY, scope, message, "task:removed")
    )
  ).rejects.toThrow(refusal);
  expect(await fingerprintOf(message, "task:removed")).toBe(
    removedKey.fingerprint
  );
  // Reported at start, once per binding, by ids and fingerprint only.
  expect(lines.filter((line) => line.includes(message))).toEqual([
    `A2A V2 result binding cannot publish (unknown-result-graph-key): tenant ${scope.tenantId} message ${message} A2A task task:removed; it was derived under result graph key ${removedKey.fingerprint}, which this host does not hold: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs`,
  ]);
  for (const line of lines) {
    expect(line).not.toContain(binding.graphWorkflowId);
  }
  // Listed as unpublishable on the authenticated route.
  expect(await assignmentStatus(service)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [],
    unpublishable: [
      {
        a2aTaskId: "task:removed",
        graphTaskId: "result-node",
        graphWorkflowId: binding.graphWorkflowId,
        keyFingerprint: removedKey.fingerprint,
        messageWorkflowId: message,
        reason: "unknown-result-graph-key",
      },
    ],
  });
  expect(
    (await without.unpublishableResultBindings(scope.tenantId)).map(
      (entry) => entry.reason
    )
  ).toEqual(["unknown-result-graph-key"]);

  // Restoring the key as a previous key makes it publishable again.
  const restored = await ledgerWith(NEW_KEY, [removedKey]);
  await expect(
    restored.resultBinding(scope, message, "task:removed")
  ).resolves.toEqual(binding);
  expect(await restored.unpublishableResultBindings(scope.tenantId)).toEqual(
    []
  );
}, 60_000);

test("a keyed binding recorded before fingerprints existed is fingerprinted at migration under the key that derives it, and is refused without one when no configured key does", async () => {
  const scope = tenant("unrecorded");
  const ledger = await ledgerWith(OLD_KEY);
  const known = await sendMessage(ledger, scope, "unrecorded-known");
  const lost = await sendMessage(ledger, scope, "unrecorded-lost");
  const lostKey = throwawayKey();
  // As the previous build recorded them: no fingerprint column value.
  for (const [message, key, task] of [
    [known, OLD_KEY, "task:unrecorded-known"],
    [lost, lostKey, "task:unrecorded-lost"],
  ] as const) {
    const binding = bindingUnder(key, scope, message, task);
    await raw`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${message}, ${task}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)`;
    await raw`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
      VALUES (${binding.graphWorkflowId}, ${"result-node"}, ${scope.tenantId}, ${task})`;
  }
  const rotated = await ledgerWith(NEW_KEY, [OLD_KEY]);
  expect(await fingerprintOf(known, "task:unrecorded-known")).toBe(
    OLD_KEY.fingerprint
  );
  expect(await fingerprintOf(lost, "task:unrecorded-lost")).toBeNull();
  await expect(
    rotated.resultBinding(scope, known, "task:unrecorded-known")
  ).resolves.toEqual(
    bindingUnder(OLD_KEY, scope, known, "task:unrecorded-known")
  );
  await expect(
    rotated.resultBinding(scope, lost, "task:unrecorded-lost")
  ).rejects.toThrow(
    "Result binding was derived under a result graph key this host does not hold, recorded before key fingerprints were: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs"
  );
  expect(
    (await rotated.unpublishableResultBindings(scope.tenantId)).map(
      ({ a2aTaskId, keyFingerprint, reason }) => ({
        a2aTaskId,
        keyFingerprint,
        reason,
      })
    )
  ).toEqual([
    {
      a2aTaskId: "task:unrecorded-lost",
      keyFingerprint: null,
      reason: "unknown-result-graph-key",
    },
  ]);
  // An older build sharing the database binds under the (shared) primary
  // key without a fingerprint: that binding publishes, and is neither under
  // a previous key nor unpublishable.
  const mixed = await sendMessage(rotated, scope, "unrecorded-mixed");
  const mixedBinding = bindingUnder(
    NEW_KEY,
    scope,
    mixed,
    "task:unrecorded-mixed"
  );
  await raw`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
    VALUES (${mixed}, ${"task:unrecorded-mixed"}, ${scope.tenantId}, ${scope.principal}, ${canonical(mixedBinding)}::jsonb)`;
  await raw`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
    VALUES (${mixedBinding.graphWorkflowId}, ${"result-node"}, ${scope.tenantId}, ${"task:unrecorded-mixed"})`;
  await expect(
    rotated.resultBinding(scope, mixed, "task:unrecorded-mixed")
  ).resolves.toEqual(mixedBinding);
  expect(
    (await rotated.previousKeyResultBindings(scope.tenantId)).map(
      ({ a2aTaskId, keyFingerprint }) => ({ a2aTaskId, keyFingerprint })
    )
  ).toEqual([
    { a2aTaskId: "task:unrecorded-known", keyFingerprint: OLD_KEY.fingerprint },
  ]);
  expect(
    (await rotated.unpublishableResultBindings(scope.tenantId)).map(
      (entry) => entry.a2aTaskId
    )
  ).toEqual(["task:unrecorded-lost"]);
}, 60_000);

test("a binding recorded under a key is immutable in the database, so an older build sharing it cannot overwrite it", async () => {
  const scope = tenant("immutable");
  const ledger = await ledgerWith(OLD_KEY);
  const message = await sendMessage(ledger, scope, "immutable");
  await saveTask(scope, "task:immutable", [message]);
  const binding = bindingUnder(OLD_KEY, scope, message, "task:immutable");
  await ledger.bindResult(scope, binding);
  // Exactly the statement the previous build's bindResult runs when it
  // cannot verify a stored binding under its own key.
  const replacement = bindingUnder(NEW_KEY, scope, message, "task:immutable");
  await expect(
    run(raw`UPDATE loop_supervisor_message_v2_result_binding SET binding_json = ${canonical(replacement)}::jsonb
      WHERE workflow_id = ${message} AND a2a_task_id = ${"task:immutable"} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`)
  ).rejects.toThrow(
    "result binding recorded under a result graph key is immutable"
  );
  await expect(
    run(raw`UPDATE loop_supervisor_message_v2_result_binding SET result_graph_key_fingerprint = NULL
      WHERE workflow_id = ${message} AND a2a_task_id = ${"task:immutable"}`)
  ).rejects.toThrow(
    "result binding recorded under a result graph key is immutable"
  );
  await expect(
    ledger.resultBinding(scope, message, "task:immutable")
  ).resolves.toEqual(binding);
  // A body-chosen binding (no key) can still be re-bound to its keyed graph.
  const bodyMessage = await sendMessage(ledger, scope, "immutable-body");
  await saveTask(scope, "task:immutable-body", [bodyMessage]);
  await raw`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
    VALUES (${bodyMessage}, ${"task:immutable-body"}, ${scope.tenantId}, ${scope.principal},
      ${canonical({ ...bindingUnder(OLD_KEY, scope, bodyMessage, "task:immutable-body"), graphWorkflowId: "task-graph:chosen-by-body" })}::jsonb)`;
  const rebound = bindingUnder(
    OLD_KEY,
    scope,
    bodyMessage,
    "task:immutable-body"
  );
  await ledger.bindResult(scope, rebound);
  await expect(
    ledger.resultBinding(scope, bodyMessage, "task:immutable-body")
  ).resolves.toEqual(rebound);
  expect(await fingerprintOf(bodyMessage, "task:immutable-body")).toBe(
    OLD_KEY.fingerprint
  );
}, 60_000);

test("a ledger refuses previous keys without a primary key, and the same key configured twice", async () => {
  await expect(
    PostgresSupervisorMessageV2DeliveryLedger.connect(postgres.databaseUrl(), {
      buildId: BUILD_ID,
      deployment: DEPLOYMENT,
      previousResultGraphKeys: [OLD_KEY],
    })
  ).rejects.toThrow("previous result graph keys require a primary key");
  const secret = randomBytes(32).toString("hex");
  await expect(
    PostgresSupervisorMessageV2DeliveryLedger.connect(postgres.databaseUrl(), {
      buildId: BUILD_ID,
      deployment: DEPLOYMENT,
      resultGraphKey: SupervisorResultGraphKey.fromSecret(secret),
      previousResultGraphKeys: [SupervisorResultGraphKey.fromSecret(secret)],
    })
  ).rejects.toThrow(
    `result graph key ${SupervisorResultGraphKey.fromSecret(secret).fingerprint} is configured more than once`
  );
});

/** The two tables every revision before reservations created. */
const createBaseTables = async (sql: SQL) => {
  await sql`CREATE TABLE loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
  await sql`CREATE TABLE loop_supervisor_message_v2_result_binding (
    workflow_id TEXT NOT NULL REFERENCES loop_supervisor_message_v2_start_intent(workflow_id),
    a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
    binding_json JSONB NOT NULL, PRIMARY KEY (workflow_id, a2a_task_id)
  )`;
};

/** Two A2A tasks carrying one message, both bound by 2b1b1893 to the same
 * unkeyed graph task: only the first can hold its reservation. */
const seedContendedLegacyBindings = async (
  sql: SQL,
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
) => {
  const workflowId = deriveSupervisorMessageV2LegacyWorkflowId(
    scope,
    dedupeKey
  );
  await sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json)
    VALUES (${workflowId}, ${scope.tenantId}, ${scope.principal}, ${canonical(inputFor(scope, dedupeKey))}::jsonb)`;
  const graphWorkflowId =
    deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId(
      scope,
      workflowId
    );
  for (const a2aTaskId of ["task:a-first", "task:b-second"]) {
    const binding = {
      a2aTaskId,
      graphTaskId: "result-node",
      graphWorkflowId,
      messageWorkflowId: workflowId,
      recipient: RECIPIENT,
    };
    await sql`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${workflowId}, ${a2aTaskId}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)`;
  }
  return { graphWorkflowId, workflowId };
};

const lostEntry = (
  scope: TrustedSupervisorMessageV2Scope,
  seeded: { graphWorkflowId: string; workflowId: string }
) => ({
  a2aTaskId: "task:b-second",
  graphTaskId: "result-node",
  graphWorkflowId: seeded.graphWorkflowId,
  messageWorkflowId: seeded.workflowId,
  reason: "lost-graph-task-reservation" as const,
  tenantId: scope.tenantId,
});

test("migration records an unkeyed binding that lost its graph task's first-binding-wins reservation as unpublishable, and service start logs it once", async () => {
  const isolated = await DisposablePostgres.create();
  const legacy = new SQL(isolated.databaseUrl());
  const lines: string[] = [];
  try {
    await legacy.connect();
    await createBaseTables(legacy);
    const scope = tenant("lost");
    const seeded = await seedContendedLegacyBindings(legacy, scope, "lost");
    const upgraded = await ledgerWith(OLD_KEY, [], isolated.databaseUrl());
    expect(await upgraded.unpublishableResultBindings()).toEqual([
      lostEntry(scope, seeded),
    ]);
    // Both unkeyed bindings are marked as such, which makes them immutable
    // in the database as well.
    expect(
      await run(
        legacy`SELECT a2a_task_id, result_graph_key_fingerprint FROM loop_supervisor_message_v2_result_binding ORDER BY a2a_task_id`
      )
    ).toEqual([
      {
        a2a_task_id: "task:a-first",
        result_graph_key_fingerprint: "unkeyed-v2",
      },
      {
        a2a_task_id: "task:b-second",
        result_graph_key_fingerprint: "unkeyed-v2",
      },
    ]);
    // The first binding keeps the graph task and publishes; the second never.
    await expect(
      upgraded.resultBinding(scope, seeded.workflowId, "task:a-first")
    ).resolves.toMatchObject({ a2aTaskId: "task:a-first" });
    await expect(
      upgraded.resultBinding(scope, seeded.workflowId, "task:b-second")
    ).resolves.toBeUndefined();
    const service = await serviceFor({
      scope,
      allow: [],
      resultGraphKey: OLD_KEY,
      databaseUrl: isolated.databaseUrl(),
      log: (line) => lines.push(line),
    });
    expect(
      lines.filter((line) => !line.startsWith("A2A V2 workflow ids:"))
    ).toEqual([
      `A2A V2 result binding will never publish (lost-graph-task-reservation): tenant ${scope.tenantId} message ${seeded.workflowId} A2A task task:b-second; it does not hold its graph task's reservation (another A2A task carrying this message holds it, or none does), and a binding to a derived graph cannot be re-bound`,
    ]);
    const status = await assignmentStatus(service);
    expect(status.unpublishable).toEqual([
      {
        a2aTaskId: "task:b-second",
        graphTaskId: "result-node",
        graphWorkflowId: seeded.graphWorkflowId,
        messageWorkflowId: seeded.workflowId,
        reason: "lost-graph-task-reservation",
      },
    ]);
    await service.close();
  } finally {
    await legacy.close();
    await isolated.close();
  }
}, 60_000);

test("migration records a lost reservation on a database the previous build already scanned, outside that build's table, and leaves that table and its reasons as they were", async () => {
  const isolated = await DisposablePostgres.create();
  const legacy = new SQL(isolated.databaseUrl());
  try {
    await legacy.connect();
    await createBaseTables(legacy);
    const scope = tenant("rescanned");
    const seeded = await seedContendedLegacyBindings(
      legacy,
      scope,
      "rescanned"
    );
    // Exactly what the previous build's migration left: its tables, the
    // first binding's reservation, its scan marker, and its reason check.
    await legacy`CREATE TABLE loop_supervisor_message_v2_result_graph_task (
      graph_workflow_id TEXT NOT NULL, graph_task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL,
      PRIMARY KEY (graph_workflow_id, graph_task_id)
    )`;
    await legacy`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
      VALUES (${seeded.graphWorkflowId}, ${"result-node"}, ${scope.tenantId}, ${"task:a-first"})`;
    await legacy`CREATE TABLE loop_supervisor_message_v2_schema_marker (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await legacy`INSERT INTO loop_supervisor_message_v2_schema_marker (name) VALUES (${"result-graph-task-backfill.v1"})`;
    await legacy`CREATE TABLE loop_supervisor_message_v2_unpublishable_result_binding (
      workflow_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('body-chosen-graph', 'malformed')),
      graph_workflow_id TEXT, graph_task_id TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workflow_id, a2a_task_id)
    )`;
    const upgraded = await ledgerWith(OLD_KEY, [], isolated.databaseUrl());
    expect(await upgraded.unpublishableResultBindings()).toEqual([
      lostEntry(scope, seeded),
    ]);
    // Once per schema version: a second start neither rescans nor duplicates.
    await upgraded.migrate();
    expect(await upgraded.unpublishableResultBindings()).toEqual([
      lostEntry(scope, seeded),
    ]);
    // The lost reservation is not in the previous build's table: after a
    // rollback that build reports its own table, and would advise re-binding
    // a lost reservation, which no build can do.
    expect(
      await run(
        legacy`SELECT reason FROM loop_supervisor_message_v2_unpublishable_result_binding`
      )
    ).toEqual([]);
    // The previous build's table and reason check are unchanged, so a
    // rollback keeps working.
    await legacy`INSERT INTO loop_supervisor_message_v2_unpublishable_result_binding (workflow_id, a2a_task_id, tenant_id, reason)
      VALUES (${seeded.workflowId}, ${"task:c-malformed"}, ${scope.tenantId}, ${"malformed"})`;
    await expect(
      run(legacy`INSERT INTO loop_supervisor_message_v2_unpublishable_result_binding (workflow_id, a2a_task_id, tenant_id, reason)
        VALUES (${seeded.workflowId}, ${"task:d-other"}, ${scope.tenantId}, ${"lost-graph-task-reservation"})`)
    ).rejects.toThrow("check constraint");
  } finally {
    await legacy.close();
    await isolated.close();
  }
}, 60_000);

test("the assignment listing names only its route tenant's bindings under a previous key, with two tenants holding them on one database", async () => {
  const scopes = [tenant("isolated-a"), tenant("isolated-b")];
  const before = await ledgerWith(OLD_KEY);
  const bindings: SupervisorA2AResultBinding[] = [];
  for (const [index, scope] of scopes.entries()) {
    const message = await sendMessage(before, scope, `isolated-${index}`);
    await saveTask(scope, `task:isolated-${index}`, [message]);
    const binding = bindingUnder(
      OLD_KEY,
      scope,
      message,
      `task:isolated-${index}`
    );
    await before.bindResult(scope, binding);
    bindings.push(binding);
  }
  for (const [index, scope] of scopes.entries()) {
    const service = await serviceFor({
      scope,
      allow: [],
      resultGraphKey: NEW_KEY,
      previousResultGraphKeys: [OLD_KEY],
    });
    const binding = bindings[index];
    expect(
      (await assignmentStatus(service)).underPreviousResultGraphKey
    ).toEqual([
      {
        a2aTaskId: binding?.a2aTaskId,
        graphTaskId: "result-node",
        graphWorkflowId: binding?.graphWorkflowId,
        keyFingerprint: OLD_KEY.fingerprint,
        messageWorkflowId: binding?.messageWorkflowId,
      },
    ]);
  }
}, 60_000);

test("re-posting a binding recorded under a key that is now a previous key is idempotent, and nothing new is bound under that key", async () => {
  const scope = tenant("idempotent");
  const before = await ledgerWith(OLD_KEY);
  const message = await sendMessage(before, scope, "idempotent");
  await saveTask(scope, "task:idempotent", [message]);
  const binding = bindingUnder(OLD_KEY, scope, message, "task:idempotent");
  await before.bindResult(scope, binding);
  // Before the rotation, another message's graph task passed from the A2A
  // task first bound to it, once that task ended, to a second one.
  const handed = await sendMessage(before, scope, "idempotent-handed");
  const first = bindingUnder(OLD_KEY, scope, handed, "task:handed-first");
  const second = bindingUnder(OLD_KEY, scope, handed, "task:handed-second");
  await before.bindResult(scope, first);
  await before.bindResult(scope, second, {
    releasable: () => Promise.resolve(true),
  });

  const service = await serviceFor({
    scope,
    allow: [
      { graphWorkflowId: binding.graphWorkflowId, graphTaskId: "result-node" },
    ],
    resultGraphKey: NEW_KEY,
    previousResultGraphKeys: [OLD_KEY],
  });
  const after = await ledgerWith(NEW_KEY, [OLD_KEY]);
  // A client retrying its assignment across the rotation gets the receipt.
  const retried = await assign(service, binding);
  expect(retried?.status).toBe(200);
  expect(await retried?.json()).toMatchObject({ assigned: true });
  await expect(after.bindResult(scope, binding)).resolves.toBeUndefined();
  expect(await fingerprintOf(message, "task:idempotent")).toBe(
    OLD_KEY.fingerprint
  );
  // Only the exact recorded binding is a retry; a change is new, refused.
  await expect(
    after.bindResult(scope, { ...binding, graphTaskId: "other-node" })
  ).rejects.toThrow(previousKeyRefusal(OLD_KEY.fingerprint));
  // A retry succeeds only while the binding still holds its graph task.
  await expect(after.bindResult(scope, second)).resolves.toBeUndefined();
  await expect(after.bindResult(scope, first)).rejects.toThrow(
    "Result graph task is reserved for another A2A task"
  );
  // Another A2A task carrying the message is not bound under that key.
  await saveTask(scope, "task:idempotent-other", [message]);
  const other = bindingUnder(OLD_KEY, scope, message, "task:idempotent-other");
  const refused = await assign(service, other);
  expect(refused?.status).toBe(409);
  expect(await refused?.json()).toEqual({
    code: "result-graph-under-previous-key",
  });
  await expect(after.bindResult(scope, other)).rejects.toThrow(
    previousKeyRefusal(OLD_KEY.fingerprint)
  );
  expect(await fingerprintOf(message, "task:idempotent-other")).toBeUndefined();
}, 60_000);

test("a result graph started under a key that is now a previous key and never bound is refused exactly, reported at start by ids only, and binds once started again under the primary key", async () => {
  const scope = tenant("stranded");
  const before = await ledgerWith(OLD_KEY);
  const message = await sendMessage(before, scope, "stranded");
  await saveTask(scope, "task:stranded", [message]);
  // Started (and listed in resultArtifacts) under the old key, not bound.
  const stranded = bindingUnder(OLD_KEY, scope, message, "task:stranded");
  const restarted = bindingUnder(NEW_KEY, scope, message, "task:stranded");
  const allow = [stranded, restarted].map(({ graphWorkflowId }) => ({
    graphWorkflowId,
    graphTaskId: "result-node",
  }));
  const lines: string[] = [];
  const service = await serviceFor({
    scope,
    allow,
    resultGraphKey: NEW_KEY,
    previousResultGraphKeys: [OLD_KEY],
    log: (line) => lines.push(line),
  });
  // Other tests' tenants share this database; this one's lines only.
  expect(lines.filter((line) => line.includes(scope.tenantId))).toEqual([
    `A2A V2 result graph cannot be bound (started-under-previous-result-graph-key): tenant ${scope.tenantId} message ${message}; resultArtifacts lists its graph under previous result graph key ${OLD_KEY.fingerprint}, no binding was recorded for the message before the rotation, and new bindings use the primary key only: start the message's result graph again under the primary key, list that graph in resultArtifacts, and bind it`,
  ]);
  for (const line of lines) {
    expect(line).not.toContain(stranded.graphWorkflowId);
  }
  const refused = await assign(service, stranded);
  expect(refused?.status).toBe(409);
  expect(await refused?.json()).toEqual({
    code: "result-graph-under-previous-key",
  });
  const after = await ledgerWith(NEW_KEY, [OLD_KEY]);
  await expect(after.bindResult(scope, stranded)).rejects.toThrow(
    previousKeyRefusal(OLD_KEY.fingerprint)
  );
  // Started again under the primary key, the message binds and publishes.
  expect((await assign(service, restarted))?.status).toBe(200);
  await service.publishResult(scope, {
    workflowId: message,
    taskId: "task:stranded",
    recipient: RECIPIENT,
  });
  expect(
    (await tasks.load("task:stranded", contextOf(scope)))?.status?.state
  ).toBe(TaskState.TASK_STATE_COMPLETED);
  // Once the message is bound, a later start no longer reports it.
  const later: string[] = [];
  await serviceFor({
    scope,
    allow,
    resultGraphKey: NEW_KEY,
    previousResultGraphKeys: [OLD_KEY],
    log: (line) => later.push(line),
  });
  expect(later.filter((line) => line.includes(scope.tenantId))).toEqual([]);
}, 60_000);

test("migration records an unkeyed binding that never held its graph task's reservation as lost", async () => {
  const isolated = await DisposablePostgres.create();
  const legacy = new SQL(isolated.databaseUrl());
  try {
    await legacy.connect();
    await createBaseTables(legacy);
    const scope = tenant("never-held");
    const seeded = await seedContendedLegacyBindings(
      legacy,
      scope,
      "never-held"
    );
    // The previous build scanned already, and neither binding holds the
    // graph task (its reservation row is gone).
    await legacy`CREATE TABLE loop_supervisor_message_v2_result_graph_task (
      graph_workflow_id TEXT NOT NULL, graph_task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL,
      PRIMARY KEY (graph_workflow_id, graph_task_id)
    )`;
    await legacy`CREATE TABLE loop_supervisor_message_v2_schema_marker (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await legacy`INSERT INTO loop_supervisor_message_v2_schema_marker (name) VALUES (${"result-graph-task-backfill.v1"})`;
    const upgraded = await ledgerWith(OLD_KEY, [], isolated.databaseUrl());
    expect(await upgraded.unpublishableResultBindings()).toEqual([
      { ...lostEntry(scope, seeded), a2aTaskId: "task:a-first" },
      lostEntry(scope, seeded),
    ]);
  } finally {
    await legacy.close();
    await isolated.close();
  }
}, 60_000);

test("a body-chosen binding recorded before keys whose graph id only looks keyed is listed once, as body-chosen, does not publish, and is re-bound to its keyed graph", async () => {
  const isolated = await DisposablePostgres.create();
  const legacy = new SQL(isolated.databaseUrl());
  try {
    await legacy.connect();
    await createBaseTables(legacy);
    const scope = tenant("lookalike");
    const workflowId = deriveSupervisorMessageV2LegacyWorkflowId(
      scope,
      "lookalike"
    );
    await legacy`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json)
      VALUES (${workflowId}, ${scope.tenantId}, ${scope.principal}, ${canonical(inputFor(scope, "lookalike"))}::jsonb)`;
    const lookalike = `supervisor-result-graph:v3:${"d".repeat(64)}`;
    await legacy`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${workflowId}, ${"task:lookalike"}, ${scope.tenantId}, ${scope.principal},
        ${canonical({ ...bindingUnder(OLD_KEY, scope, workflowId, "task:lookalike"), graphWorkflowId: lookalike })}::jsonb)`;
    const upgraded = await ledgerWith(OLD_KEY, [], isolated.databaseUrl());
    expect(await upgraded.unpublishableResultBindings()).toEqual([
      {
        a2aTaskId: "task:lookalike",
        graphTaskId: "result-node",
        graphWorkflowId: lookalike,
        messageWorkflowId: workflowId,
        reason: "body-chosen-graph",
        tenantId: scope.tenantId,
      },
    ]);
    await expect(
      upgraded.resultBinding(scope, workflowId, "task:lookalike")
    ).resolves.toBeUndefined();
    const rebound = bindingUnder(OLD_KEY, scope, workflowId, "task:lookalike");
    await upgraded.bindResult(scope, rebound);
    await expect(
      upgraded.resultBinding(scope, workflowId, "task:lookalike")
    ).resolves.toEqual(rebound);
    expect(await upgraded.unpublishableResultBindings()).toEqual([]);
  } finally {
    await legacy.close();
    await isolated.close();
  }
}, 60_000);

test("a keyed binding an older build recorded without a fingerprint is immutable before any newer build fingerprints it", async () => {
  const scope = tenant("unfingerprinted");
  const ledger = await ledgerWith(OLD_KEY);
  const message = await sendMessage(ledger, scope, "unfingerprinted");
  // As an older build holding another key binds it: no fingerprint.
  const binding = bindingUnder(
    throwawayKey(),
    scope,
    message,
    "task:unfingerprinted"
  );
  await raw`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
    VALUES (${message}, ${"task:unfingerprinted"}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)`;
  // Exactly the statement an older build holding OLD_KEY runs when it
  // cannot verify the stored binding under its own key.
  const replacement = bindingUnder(
    OLD_KEY,
    scope,
    message,
    "task:unfingerprinted"
  );
  await expect(
    run(raw`UPDATE loop_supervisor_message_v2_result_binding SET binding_json = ${canonical(replacement)}::jsonb
      WHERE workflow_id = ${message} AND a2a_task_id = ${"task:unfingerprinted"} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`)
  ).rejects.toThrow(
    "result binding recorded under a result graph key is immutable"
  );
  expect(await fingerprintOf(message, "task:unfingerprinted")).toBeNull();
}, 60_000);

test("a later start neither re-creates the immutability trigger nor alters the binding table, so it does not wait on an open binding write", async () => {
  const ledger = await ledgerWith(OLD_KEY);
  const trigger = async () =>
    (
      (await raw`SELECT oid::text AS oid FROM pg_trigger WHERE tgname = ${"loop_v2_result_binding_keyed_immutable"}`) as {
        oid: string;
      }[]
    ).map((row) => row.oid);
  const created = await trigger();
  expect(created).toHaveLength(1);
  let outcome = "";
  await raw.begin(async (tx) => {
    // An open write holds ROW EXCLUSIVE on the binding table until commit.
    await tx`UPDATE loop_supervisor_message_v2_result_binding SET principal = principal WHERE false`;
    outcome = await Promise.race([
      ledger.migrate().then(() => "migrated"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("waited"), 5000)
      ),
    ]);
  });
  expect(outcome).toBe("migrated");
  expect(await trigger()).toEqual(created);
}, 60_000);

test("a host holding no result graph key names the key to configure for a binding derived under a key it does not hold", async () => {
  const scope = tenant("keyless");
  const keyed = await ledgerWith(OLD_KEY);
  const message = await sendMessage(keyed, scope, "keyless");
  await keyed.bindResult(
    scope,
    bindingUnder(OLD_KEY, scope, message, "task:keyless")
  );
  const keyless = await ledgerWith(undefined);
  const advice =
    "this host holds no result graph key, so name one in a2aV2.resultGraphKeyEnv and add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs";
  await expect(
    keyless.resultBinding(scope, message, "task:keyless")
  ).rejects.toThrow(
    `Result binding was derived under result graph key ${OLD_KEY.fingerprint}, which this host does not hold: ${advice}`
  );
  // A host started without a key reports it with the same advice.
  const lines: string[] = [];
  await serviceFor({
    scope,
    allow: [],
    resultGraphKey: undefined,
    log: (line) => lines.push(line),
  });
  expect(lines.filter((line) => line.includes(scope.tenantId))).toEqual([
    `A2A V2 result binding cannot publish (unknown-result-graph-key): tenant ${scope.tenantId} message ${message} A2A task task:keyless; it was derived under result graph key ${OLD_KEY.fingerprint}, which this host does not hold: ${advice}`,
  ]);
}, 60_000);

/** The listing entry of a binding under `key`, without its tenant. */
const listedUnder = (
  key: SupervisorResultGraphKey,
  binding: SupervisorA2AResultBinding
) => ({
  a2aTaskId: binding.a2aTaskId,
  graphTaskId: binding.graphTaskId,
  graphWorkflowId: binding.graphWorkflowId,
  keyFingerprint: key.fingerprint,
  messageWorkflowId: binding.messageWorkflowId,
});

/** Start lines other than the workflow id format line every start logs. */
const findings = (lines: readonly string[]) =>
  lines.filter((line) => !line.startsWith("A2A V2 workflow ids:"));

/** As an older build records a binding: it names no deployment. */
const forgetBinder = (workflowIds: readonly string[], sql: SQL = raw) =>
  run(sql`UPDATE loop_supervisor_message_v2_result_binding SET bound_by_deployment = NULL
    WHERE workflow_id IN ${sql(workflowIds)}`);

test("two deployments holding different result graph keys on one database each classify, list and report only their own bindings", async () => {
  // One tenant on both: only the deployment tells their bindings apart.
  const scope = tenant("shared");
  const firstKeyA = throwawayKey();
  const keyA = throwawayKey();
  const keyB = throwawayKey();
  const beforeA = await deploymentLedger({
    deployment: "deployment-a",
    resultGraphKey: firstKeyA,
  });
  const ledgerB = await deploymentLedger({
    deployment: "deployment-b",
    resultGraphKey: keyB,
  });
  const messageA = await sendMessage(beforeA, scope, "shared-a");
  const messageB = await sendMessage(ledgerB, scope, "shared-b");
  // A message of B that is not bound. A's resultArtifacts happens to list
  // the graph A's previous key derives for it: still not A's message.
  const unboundB = await sendMessage(ledgerB, scope, "shared-b-unbound");
  await saveTask(scope, "task:shared-a", [messageA]);
  await saveTask(scope, "task:shared-b", [messageB]);
  const bindingA = bindingUnder(firstKeyA, scope, messageA, "task:shared-a");
  const bindingB = bindingUnder(keyB, scope, messageB, "task:shared-b");
  await beforeA.bindResult(scope, bindingA);
  await ledgerB.bindResult(scope, bindingB);
  // Deployment A rotates; deployment B keeps its one key.
  const ledgerA = await deploymentLedger({
    deployment: "deployment-a",
    previousResultGraphKeys: [firstKeyA],
    resultGraphKey: keyA,
  });

  // Neither classifies the other's binding as under a key it lacks, with or
  // without a tenant, and only A's own binding is under a previous key.
  for (const ledger of [ledgerA, ledgerB]) {
    expect(await ledger.unpublishableResultBindings()).toEqual([]);
    expect(await ledger.unpublishableResultBindings(scope.tenantId)).toEqual(
      []
    );
  }
  expect(await ledgerA.previousKeyResultBindings()).toEqual([
    { ...listedUnder(firstKeyA, bindingA), tenantId: scope.tenantId },
  ]);
  expect(await ledgerB.previousKeyResultBindings()).toEqual([]);
  // Each deployment's binding still publishes on its own hosts.
  await expect(
    ledgerA.resultBinding(scope, messageA, "task:shared-a")
  ).resolves.toEqual(bindingA);
  await expect(
    ledgerB.resultBinding(scope, messageB, "task:shared-b")
  ).resolves.toEqual(bindingB);

  // Starting either host reports nothing about the other's binding, and the
  // authenticated listing names only its own.
  const linesA: string[] = [];
  const linesB: string[] = [];
  const serviceA = await serviceFor({
    scope,
    allow: [
      {
        graphTaskId: "result-node",
        graphWorkflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
          firstKeyA,
          scope,
          unboundB
        ),
      },
    ],
    deployment: "deployment-a",
    log: (line) => linesA.push(line),
    previousResultGraphKeys: [firstKeyA],
    resultGraphKey: keyA,
  });
  const serviceB = await serviceFor({
    scope,
    allow: [],
    deployment: "deployment-b",
    log: (line) => linesB.push(line),
    resultGraphKey: keyB,
  });
  expect(findings(linesA)).toEqual([]);
  expect(findings(linesB)).toEqual([]);
  expect(await assignmentStatus(serviceA)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [listedUnder(firstKeyA, bindingA)],
    unpublishable: [],
  });
  expect(await assignmentStatus(serviceB)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [],
    unpublishable: [],
  });

  // A binding an older build recorded names no deployment: it is
  // attributed by its message, which in deployment ids names its own.
  await forgetBinder([messageA, messageB]);
  expect(await ledgerA.unpublishableResultBindings()).toEqual([]);
  expect(await ledgerB.unpublishableResultBindings()).toEqual([]);
  expect(await ledgerA.previousKeyResultBindings()).toEqual([
    { ...listedUnder(firstKeyA, bindingA), tenantId: scope.tenantId },
  ]);

  // A's own binding under a key A no longer holds is still reported, by A.
  const removedA = await deploymentLedger({
    deployment: "deployment-a",
    resultGraphKey: keyA,
  });
  expect(
    (await removedA.unpublishableResultBindings()).map((entry) => [
      entry.messageWorkflowId,
      entry.reason,
    ])
  ).toEqual([[messageA, "unknown-result-graph-key"]]);
}, 60_000);

test("with legacy workflow ids, whose messages name no deployment, a binding is attributed to the deployment that recorded it, and one recorded by an older build to its tenant", async () => {
  const isolated = await DisposablePostgres.create();
  const isolatedSql = new SQL(isolated.databaseUrl());
  try {
    await isolatedSql.connect();
    const databaseUrl = isolated.databaseUrl();
    const scope = tenant("legacy-shared");
    const other = tenant("legacy-other");
    const keyA = throwawayKey();
    const keyB = throwawayKey();
    const ledgerA = await deploymentLedger({
      databaseUrl,
      deployment: "legacy-a",
      resultGraphKey: keyA,
      workflowIdFormat: "legacy",
    });
    const ledgerB = await deploymentLedger({
      databaseUrl,
      deployment: "legacy-b",
      resultGraphKey: keyB,
      workflowIdFormat: "legacy",
    });
    const messageA = await sendMessage(ledgerA, scope, "legacy-a");
    const messageB = await sendMessage(ledgerB, scope, "legacy-b");
    const messageOther = await sendMessage(ledgerB, other, "legacy-other");
    expect(messageA).toBe(
      deriveSupervisorMessageV2LegacyWorkflowId(scope, "legacy-a")
    );
    const bindingA = bindingUnder(keyA, scope, messageA, "task:legacy-a");
    const bindingB = bindingUnder(keyB, scope, messageB, "task:legacy-b");
    const bindingOther = bindingUnder(
      keyB,
      other,
      messageOther,
      "task:legacy-other"
    );
    await ledgerA.bindResult(scope, bindingA);
    await ledgerB.bindResult(scope, bindingB);
    await ledgerB.bindResult(other, bindingOther);
    for (const ledger of [ledgerA, ledgerB]) {
      expect(await ledger.unpublishableResultBindings()).toEqual([]);
    }
    const linesA: string[] = [];
    await serviceFor({
      scope,
      allow: [],
      databaseUrl,
      deployment: "legacy-a",
      log: (line) => linesA.push(line),
      resultGraphKey: keyA,
      workflowIdFormat: "legacy",
    });
    expect(findings(linesA)).toEqual([]);

    // Recorded by an older build, a legacy binding names no deployment, so
    // the host's start report keeps to its own route tenant. Within that
    // tenant, another deployment's such binding cannot be told apart from
    // one under a key this deployment removed (the documented limit of
    // legacy ids): it is reported.
    await forgetBinder([messageA, messageB, messageOther], isolatedSql);
    const later: string[] = [];
    await serviceFor({
      scope,
      allow: [],
      databaseUrl,
      deployment: "legacy-a",
      log: (line) => later.push(line),
      resultGraphKey: keyA,
      workflowIdFormat: "legacy",
    });
    expect(findings(later)).toEqual([
      `A2A V2 result binding cannot publish (unknown-result-graph-key): tenant ${scope.tenantId} message ${messageB} A2A task task:legacy-b; it was derived under result graph key ${keyB.fingerprint}, which this host does not hold: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs`,
    ]);
  } finally {
    for (const resource of opened.splice(0)) {
      await resource.close().catch(() => undefined);
    }
    await isolatedSql.close();
    await isolated.close();
  }
}, 60_000);

test("a previous key is no longer needed once every binding under it has settled: the listing drops a binding when its result publishes or its A2A task ends without one, and a host started without the key then reports nothing", async () => {
  const scope = tenant("retire");
  const retiring = throwawayKey();
  const before = await ledgerWith(retiring);
  // One A2A task carries two messages; another carries a third.
  const first = await sendMessage(before, scope, "retire-first");
  const second = await sendMessage(before, scope, "retire-second");
  const third = await sendMessage(before, scope, "retire-third");
  await saveTask(scope, "task:retire-shared", [first, second]);
  await saveTask(scope, "task:retire-ended", [third]);
  const bindings = [
    bindingUnder(retiring, scope, first, "task:retire-shared"),
    bindingUnder(retiring, scope, second, "task:retire-shared"),
    bindingUnder(retiring, scope, third, "task:retire-ended"),
  ] as const;
  for (const binding of bindings) {
    await before.bindResult(scope, binding);
  }
  const [firstBinding] = bindings;
  const service = await serviceFor({
    scope,
    allow: bindings.map(({ graphWorkflowId }) => ({
      graphWorkflowId,
      graphTaskId: "result-node",
    })),
    previousResultGraphKeys: [retiring],
    resultGraphKey: NEW_KEY,
  });
  const listed = async () =>
    (
      (await assignmentStatus(service)).underPreviousResultGraphKey as {
        messageWorkflowId: string;
      }[]
    ).map((entry) => entry.messageWorkflowId);
  const byMessage = (ids: string[]) => [...ids].sort();
  expect(byMessage(await listed())).toEqual(byMessage([first, second, third]));
  expect(
    (await assignmentStatus(service)).underPreviousResultGraphKey
  ).toContainEqual(listedUnder(retiring, firstBinding));

  // The first message's result publishes. Its A2A task still waits for the
  // second, so only the published artifact settles the binding.
  await service.publishResult(scope, {
    recipient: RECIPIENT,
    taskId: "task:retire-shared",
    workflowId: first,
  });
  expect(
    (await tasks.load("task:retire-shared", contextOf(scope)))?.status?.state
  ).toBe(TaskState.TASK_STATE_WORKING);
  expect(byMessage(await listed())).toEqual(byMessage([second, third]));

  // An A2A task that ended without a result can never publish one.
  await saveTask(
    scope,
    "task:retire-ended",
    [third],
    TaskState.TASK_STATE_CANCELED
  );
  expect(await listed()).toEqual([second]);
  // Still listed, so still needed: a host without the key would strand it.
  const early: string[] = [];
  await serviceFor({
    scope,
    allow: [],
    log: (line) => early.push(line),
    resultGraphKey: NEW_KEY,
  });
  expect(early.filter((line) => line.includes(scope.tenantId))).toEqual([
    `A2A V2 result binding cannot publish (unknown-result-graph-key): tenant ${scope.tenantId} message ${second} A2A task task:retire-shared; it was derived under result graph key ${retiring.fingerprint}, which this host does not hold: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs`,
  ]);

  await service.publishResult(scope, {
    recipient: RECIPIENT,
    taskId: "task:retire-shared",
    workflowId: second,
  });
  expect(
    (await tasks.load("task:retire-shared", contextOf(scope)))?.status?.state
  ).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(await listed()).toEqual([]);

  // Retired: a host started without the key reports and lists nothing for
  // these bindings, though they stay recorded under it.
  const lines: string[] = [];
  const retired = await serviceFor({
    scope,
    allow: [],
    log: (line) => lines.push(line),
    resultGraphKey: NEW_KEY,
  });
  expect(lines.filter((line) => line.includes(scope.tenantId))).toEqual([]);
  expect(await assignmentStatus(retired)).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    underPreviousResultGraphKey: [],
    unpublishable: [],
  });
  expect(await fingerprintOf(third, "task:retire-ended")).toBe(
    retiring.fingerprint
  );
}, 60_000);

/** The start line of a binding under `key` on a host that does not hold it. */
const unknownKeyLine = (
  scope: TrustedSupervisorMessageV2Scope,
  key: SupervisorResultGraphKey,
  binding: SupervisorA2AResultBinding
) =>
  `A2A V2 result binding cannot publish (unknown-result-graph-key): tenant ${scope.tenantId} message ${binding.messageWorkflowId} A2A task ${binding.a2aTaskId}; it was derived under result graph key ${key.fingerprint}, which this host does not hold: add the environment variable holding that key to a2aV2.previousResultGraphKeyEnvs`;

test("a settled check that cannot read the A2A task store keeps the binding listed and reported: a failing read never hides a binding under a previous or removed key", async () => {
  const scope = tenant("unreadable");
  const retiring = throwawayKey();
  const before = await ledgerWith(retiring);
  const message = await sendMessage(before, scope, "unreadable");
  // Read, this task would settle the binding: it ended without a result.
  await saveTask(
    scope,
    "task:unreadable",
    [message],
    TaskState.TASK_STATE_CANCELED
  );
  const binding = bindingUnder(retiring, scope, message, "task:unreadable");
  await before.bindResult(scope, binding);
  const reads = { failing: true };
  const service = await serviceFor({
    scope,
    allow: [
      { graphWorkflowId: binding.graphWorkflowId, graphTaskId: "result-node" },
    ],
    previousResultGraphKeys: [retiring],
    resultGraphKey: NEW_KEY,
    taskReads: reads,
  });
  const ofTenant = (lines: readonly string[]) =>
    lines.filter((line) => line.includes(scope.tenantId));

  // The task store cannot be read: the binding stays listed, so its key is
  // still needed, and a host without the key reports it.
  expect((await assignmentStatus(service)).underPreviousResultGraphKey).toEqual(
    [listedUnder(retiring, binding)]
  );
  const unreadable: string[] = [];
  await serviceFor({
    scope,
    allow: [],
    log: (line) => unreadable.push(line),
    resultGraphKey: NEW_KEY,
    taskReads: reads,
  });
  expect(ofTenant(unreadable)).toEqual([
    unknownKeyLine(scope, retiring, binding),
  ]);

  // Control: once the store reads again, the same task settles the binding.
  reads.failing = false;
  expect((await assignmentStatus(service)).underPreviousResultGraphKey).toEqual(
    []
  );
  const readable: string[] = [];
  await serviceFor({
    scope,
    allow: [],
    log: (line) => readable.push(line),
    resultGraphKey: NEW_KEY,
    taskReads: reads,
  });
  expect(ofTenant(readable)).toEqual([]);
}, 60_000);

test("a COMPLETED A2A task without the message's accepted artifact does not settle that message's binding: only the artifact or an ending without a result does", async () => {
  const scope = tenant("completed");
  const retiring = throwawayKey();
  const before = await ledgerWith(retiring);
  // One A2A task carries two messages; only the first one's result publishes.
  const published = await sendMessage(before, scope, "completed-published");
  const unpublished = await sendMessage(before, scope, "completed-unpublished");
  await saveTask(scope, "task:completed", [published, unpublished]);
  const bindings = [
    bindingUnder(retiring, scope, published, "task:completed"),
    bindingUnder(retiring, scope, unpublished, "task:completed"),
  ] as const;
  for (const binding of bindings) {
    await before.bindResult(scope, binding);
  }
  const [, unpublishedBinding] = bindings;
  const service = await serviceFor({
    scope,
    allow: bindings.map(({ graphWorkflowId }) => ({
      graphWorkflowId,
      graphTaskId: "result-node",
    })),
    previousResultGraphKeys: [retiring],
    resultGraphKey: NEW_KEY,
  });
  await service.publishResult(scope, {
    recipient: RECIPIENT,
    taskId: "task:completed",
    workflowId: published,
  });

  // The A2A task completes holding only the first message's result.
  const held = await tasks.load("task:completed", contextOf(scope));
  if (!held?.status) {
    throw new Error("missing A2A task task:completed");
  }
  expect(held.artifacts.map(({ artifactId }) => artifactId)).toEqual([
    acceptedResultArtifactId(published),
  ]);
  await tasks.save(
    {
      ...held,
      status: { ...held.status, state: TaskState.TASK_STATE_COMPLETED },
    },
    contextOf(scope)
  );
  expect(
    (await tasks.load("task:completed", contextOf(scope)))?.status?.state
  ).toBe(TaskState.TASK_STATE_COMPLETED);

  // The second message's result never published, so its binding still needs
  // the key: listed here, reported by a host without it.
  expect((await assignmentStatus(service)).underPreviousResultGraphKey).toEqual(
    [listedUnder(retiring, unpublishedBinding)]
  );
  const lines: string[] = [];
  await serviceFor({
    scope,
    allow: [],
    log: (line) => lines.push(line),
    resultGraphKey: NEW_KEY,
  });
  expect(lines.filter((line) => line.includes(scope.tenantId))).toEqual([
    unknownKeyLine(scope, retiring, unpublishedBinding),
  ]);
}, 60_000);

test("a settled binding is remembered durably: after more rotations and on a fresh host the settled check is never asked about it again, while an unsettled binding is checked every time", async () => {
  const scope = tenant("memo");
  const first = throwawayKey();
  const second = throwawayKey();
  const third = throwawayKey();
  const before = await ledgerWith(first);
  const settledMessage = await sendMessage(before, scope, "memo-settled");
  const openMessage = await sendMessage(before, scope, "memo-open");
  const failingMessage = await sendMessage(before, scope, "memo-failing");
  const settledBinding = bindingUnder(
    first,
    scope,
    settledMessage,
    "task:memo-settled"
  );
  const openBinding = bindingUnder(first, scope, openMessage, "task:memo-open");
  const failingBinding = bindingUnder(
    first,
    scope,
    failingMessage,
    "task:memo-failing"
  );
  for (const binding of [settledBinding, openBinding, failingBinding]) {
    await before.bindResult(scope, binding);
  }
  const asked: string[] = [];
  // The host's check: one binding has settled, one has not (its task is
  // still running or missing), and one cannot be read (the check fails).
  const settled = (binding: SupervisorA2AResultBinding) => {
    asked.push(binding.messageWorkflowId);
    if (binding.messageWorkflowId === failingMessage) {
      return Promise.reject(new Error("task store unavailable"));
    }
    return Promise.resolve(binding.messageWorkflowId === settledMessage);
  };
  const askedAbout = (workflowId: string) =>
    asked.filter((entry) => entry === workflowId).length;
  const previousListed = async (
    ledger: PostgresSupervisorMessageV2DeliveryLedger
  ) =>
    (await ledger.previousKeyResultBindings(scope.tenantId, { settled }))
      .map((entry) => entry.messageWorkflowId)
      .sort();
  const stillNeeded = [openMessage, failingMessage].sort();

  // Rotation 1: the first key is a previous key.
  const rotated = await ledgerWith(second, [first]);
  expect(await previousListed(rotated)).toEqual(stillNeeded);
  expect(await previousListed(rotated)).toEqual(stillNeeded);
  expect(askedAbout(settledMessage)).toBe(1);
  expect(askedAbout(openMessage)).toBe(2);
  expect(askedAbout(failingMessage)).toBe(2);

  // Rotation 2, on a fresh host (new connection): still never asked again.
  const again = await ledgerWith(third, [second, first]);
  expect(await previousListed(again)).toEqual(stillNeeded);
  expect(askedAbout(settledMessage)).toBe(1);
  expect(askedAbout(openMessage)).toBe(3);

  // The first key removed: the unsettled bindings are under an unknown key,
  // and the settled one is neither listed nor asked about.
  const removed = await ledgerWith(third, [second]);
  expect(
    (await removed.unpublishableResultBindings(scope.tenantId, { settled }))
      .map((entry) => [entry.messageWorkflowId, entry.reason])
      .sort()
  ).toEqual(
    stillNeeded.map((workflowId) => [workflowId, "unknown-result-graph-key"])
  );
  expect(askedAbout(settledMessage)).toBe(1);
  expect(askedAbout(openMessage)).toBe(4);
  expect(askedAbout(failingMessage)).toBe(4);

  // Without a settled check nothing is hidden: the binding stays recorded.
  expect(
    (await again.previousKeyResultBindings(scope.tenantId))
      .map((entry) => entry.messageWorkflowId)
      .sort()
  ).toEqual([settledMessage, ...stillNeeded].sort());
  expect(await fingerprintOf(settledMessage, "task:memo-settled")).toBe(
    first.fingerprint
  );
}, 60_000);

test("a settled binding is remembered per deployment: another deployment sharing the database still asks its own check", async () => {
  // Legacy ids on a database of their own: a legacy binding an older build
  // recorded names no deployment, so every deployment treats it as its own.
  const isolated = await DisposablePostgres.create();
  try {
    const databaseUrl = isolated.databaseUrl();
    const scope = tenant("memo-shared");
    const key = throwawayKey();
    const legacy = await deploymentLedger({
      databaseUrl,
      resultGraphKey: key,
      workflowIdFormat: "legacy",
    });
    const message = await sendMessage(legacy, scope, "memo-shared");
    await legacy.bindResult(
      scope,
      bindingUnder(key, scope, message, "task:memo-shared")
    );
    const isolatedSql = new SQL(databaseUrl);
    try {
      await isolatedSql.connect();
      await forgetBinder([message], isolatedSql);
    } finally {
      await isolatedSql.close();
    }
    const asked: string[] = [];
    const listedBy = async (deployment: string, answer: boolean) => {
      const ledger = await deploymentLedger({
        databaseUrl,
        deployment,
        previousResultGraphKeys: [key],
        resultGraphKey: NEW_KEY,
        workflowIdFormat: "legacy",
      });
      return (
        await ledger.previousKeyResultBindings(scope.tenantId, {
          settled: () => {
            asked.push(deployment);
            return Promise.resolve(answer);
          },
        })
      ).map((entry) => entry.messageWorkflowId);
    };
    expect(await listedBy("memo-queue-a", true)).toEqual([]);
    expect(await listedBy("memo-queue-a", true)).toEqual([]);
    expect(await listedBy("memo-queue-b", false)).toEqual([message]);
    expect(asked).toEqual(["memo-queue-a", "memo-queue-b"]);
  } finally {
    for (const resource of opened.splice(0)) {
      await resource.close().catch(() => undefined);
    }
    await isolated.close();
  }
}, 120_000);

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMailboxReconcilers,
  createOrchestrationSweep,
} from "../../src/loop/loop-orchestration-server";
import {
  MailboxV2RouteUnresolvedError,
  runMailboxCommand,
  runMailboxCommandWithV2Ack,
} from "../../src/loop/mailbox-command";
import { mailboxPathFor } from "../../src/loop/supervisor-mailbox-delivery";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2Projection,
} from "../../src/loop/supervisor-message-v2-contract";
import { SupervisorMessageV2GovernanceError } from "../../src/loop/supervisor-message-v2-governance";
import {
  createSupervisorMessageV2RecipientHttpHandler,
  runSupervisorMessageV2RecipientLifecycle,
} from "../../src/loop/supervisor-message-v2-http";
import { SupervisorMessageV2RecipientTooEarlyError } from "../../src/loop/supervisor-message-v2-runtime";
import { WorkflowError } from "../../src/loop/workflow-port";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-server-")));
  roots.push(root);
  return root;
};

const BOB = "supervisor:bob";
const SENDER = { principal: "principal:sender", tenantId: "tenant:ra2" };
const WORKFLOW = deriveSupervisorMessageV2WorkflowId(SENDER, "d-1", "ra2");
const projection = (phase: string) =>
  ({
    acknowledgedAt: null,
    claimedAt: null,
    phase,
  }) as unknown as SupervisorMessageV2Projection;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the in-process lifecycle accepts only a delivery key this workflow issued under its own scope", async () => {
  const governed: string[] = [];
  const options = {
    governance: {
      acknowledge: () => Promise.resolve(projection("acknowledged")),
      claim: (command: { requestId: string }) => {
        governed.push(command.requestId);
        return Promise.resolve(projection("claimed"));
      },
    },
    resolveAssignment: () => Promise.resolve(SENDER),
  };
  const identity = { principal: "principal:bob", supervisorId: BOB };
  const command = {
    operation: "claim" as const,
    requestId: "r-1",
    workflowId: WORKFLOW,
  };
  for (const attempt of [1, 7, 20]) {
    expect(
      await runSupervisorMessageV2RecipientLifecycle(options, identity, {
        ...command,
        deliveryKey: deriveSupervisorMessageV2DeliveryId(
          SENDER,
          WORKFLOW,
          attempt
        ),
      })
    ).toMatchObject({ kind: "receipt", projection: { phase: "claimed" } });
  }
  const refusedKeys = [
    // Another scope's id for the same workflow.
    deriveSupervisorMessageV2DeliveryId(
      { ...SENDER, principal: "principal:other" },
      WORKFLOW,
      1
    ),
    // Another workflow's id.
    deriveSupervisorMessageV2DeliveryId(
      SENDER,
      deriveSupervisorMessageV2WorkflowId(SENDER, "d-2", "ra2"),
      1
    ),
    `supervisor-message-delivery:v2:${"0".repeat(64)}`,
  ];
  for (const deliveryKey of refusedKeys) {
    expect(
      await runSupervisorMessageV2RecipientLifecycle(options, identity, {
        ...command,
        deliveryKey,
      })
    ).toEqual({ code: "assignment-denied", kind: "refused" });
  }
  expect(governed).toHaveLength(3);
  // Without a key (the HTTP route's case) nothing more is checked here.
  await runSupervisorMessageV2RecipientLifecycle(options, identity, command);
  expect(governed).toHaveLength(4);
});

test("the in-process lifecycle tells a decided refusal from a transient one; the HTTP route answers both the same", async () => {
  const errors: unknown[] = [
    new WorkflowError("invalid-state", "already acknowledged"),
    new SupervisorMessageV2GovernanceError({
      allowed: false,
      authorityRef: "authority:test",
      reasonCode: "denied",
    }),
    new Error("temporal unavailable"),
    new SupervisorMessageV2RecipientTooEarlyError("not-claimed", null),
  ];
  const outcomes: unknown[] = [];
  const statuses: number[] = [];
  for (const error of errors) {
    const options = {
      governance: {
        acknowledge: () => Promise.reject(error),
        claim: () => Promise.reject(error),
      },
      resolveAssignment: () => Promise.resolve(SENDER),
    };
    outcomes.push(
      await runSupervisorMessageV2RecipientLifecycle(
        options,
        { principal: "principal:bob", supervisorId: BOB },
        { operation: "acknowledge", requestId: "r", workflowId: WORKFLOW }
      )
    );
    const handler = createSupervisorMessageV2RecipientHttpHandler({
      ...options,
      authenticator: {
        authenticate: () => ({ principal: "principal:bob", supervisorId: BOB }),
      },
      pathname: "/recipient",
    });
    const response = await handler(
      new Request("http://local/recipient", {
        body: JSON.stringify({
          operation: "acknowledge",
          requestId: "r",
          workflowId: WORKFLOW,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    statuses.push(response.status);
    if (error instanceof SupervisorMessageV2RecipientTooEarlyError) {
      expect(await response.json()).toEqual({ code: "not-claimed" });
    } else {
      expect(await response.json()).toEqual({
        code: "lifecycle-command-refused",
      });
    }
  }
  expect(outcomes).toEqual([
    { code: "lifecycle-command-refused", kind: "refused", transient: false },
    { code: "lifecycle-command-refused", kind: "refused", transient: false },
    { code: "lifecycle-command-refused", kind: "refused", transient: true },
    { code: "not-claimed", kind: "refused", retryAt: null },
  ]);
  expect(statuses).toEqual([409, 409, 409, 409]);
});

test("a delivery key is never accepted from the HTTP body: only in-process callers can present one", async () => {
  let governed = 0;
  const handler = createSupervisorMessageV2RecipientHttpHandler({
    authenticator: {
      authenticate: () => ({ principal: "principal:bob", supervisorId: BOB }),
    },
    governance: {
      acknowledge: () => Promise.reject(new Error("unexpected")),
      claim: () => {
        governed += 1;
        return Promise.resolve(projection("claimed"));
      },
    },
    pathname: "/recipient",
    resolveAssignment: () => Promise.resolve(SENDER),
  });
  const response = await handler(
    new Request("http://local/recipient", {
      body: JSON.stringify({
        deliveryKey: deriveSupervisorMessageV2DeliveryId(SENDER, WORKFLOW, 1),
        operation: "claim",
        requestId: "r",
        workflowId: WORKFLOW,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.status).toBe(400);
  expect(governed).toBe(0);
});

test("a hung or failing V2 reconciler never delays V1 reconciliation or changes its health", async () => {
  const v1Passes: number[] = [];
  const health: boolean[] = [];
  const logs: string[] = [];
  let hungStarts = 0;
  let failingStarts = 0;
  let failure = "postgres down";
  const sweep = createOrchestrationSweep({
    log: (line) => logs.push(line),
    reconcilers: [
      {
        reconcile: () => {
          v1Passes.push(v1Passes.length);
          return Promise.resolve();
        },
      },
    ],
    setHealthy: (healthy) => health.push(healthy),
    v2Reconcilers: [
      {
        // Never settles.
        reconcile: () => {
          hungStarts += 1;
          return new Promise(() => undefined);
        },
      },
      {
        reconcile: () => {
          failingStarts += 1;
          if (failingStarts === 4) {
            // Throws synchronously, not even a rejected promise.
            throw new Error(failure);
          }
          return failingStarts >= 5
            ? Promise.resolve()
            : Promise.reject(new Error(failure));
        },
      },
    ],
  });
  for (let tick = 0; tick < 6; tick += 1) {
    if (tick === 2) {
      failure = "temporal down";
    }
    await sweep();
    await flush();
  }
  expect(v1Passes).toHaveLength(6);
  expect(health).toEqual([true, true, true, true, true, true]);
  // The hung pass is never re-entered.
  expect(hungStarts).toBe(1);
  expect(failingStarts).toBe(6);
  // Reported once per change, and its recovery once.
  expect(logs).toEqual([
    "orchestration A2A V2 mailbox ACK pass failed: postgres down",
    "orchestration A2A V2 mailbox ACK pass failed: temporal down",
    "orchestration A2A V2 mailbox ACK pass recovered",
  ]);
});

test("the V2 mailbox reconciler exists only for mailbox recipients while the V2 plane is up with a recipient route", () => {
  const runtime = {
    acknowledge: () => Promise.resolve(),
    claim: () => Promise.resolve(),
    threads: () => ({
      revision: 0,
      schema: "supervisor-thread-board.v1" as const,
      threads: [],
    }),
  };
  const supervisors = [
    {
      mailbox: "/tmp/ra2/bob.jsonl",
      principal: "principal:bob",
      supervisorId: BOB,
    },
    { principal: "principal:pane", supervisorId: "supervisor:pane" },
  ];
  const lifecycle = () =>
    Promise.resolve({ code: "assignment-denied", kind: "refused" } as const);
  const v2Service = {
    recipientRoute: {
      httpHandler: () => Promise.resolve(new Response()),
      lifecycle,
      pathname: "/a2a/recipient",
    },
  };
  const base = { log: () => undefined, runtime, supervisors };
  expect(
    createMailboxReconcilers({ ...base, v2PlaneState: "ready", v2Service }).v2
  ).toHaveLength(1);
  expect(
    createMailboxReconcilers({ ...base, v2PlaneState: "disabled", v2Service })
      .v2
  ).toHaveLength(0);
  expect(
    createMailboxReconcilers({ ...base, v2PlaneState: "ready" }).v2
  ).toHaveLength(0);
  expect(
    createMailboxReconcilers({
      ...base,
      v2PlaneState: "ready",
      v2Service: {
        recipientRoute: {
          httpHandler: () => Promise.resolve(new Response()),
          pathname: "/a2a/recipient",
        },
      },
    }).v2
  ).toHaveLength(0);
  expect(
    createMailboxReconcilers({
      ...base,
      supervisors: [supervisors[1] as (typeof supervisors)[1]],
      v2PlaneState: "ready",
      v2Service,
    }).v2
  ).toHaveLength(0);
});

const v2Envelope = (key: string) => ({
  artifactRefs: [],
  at: "2026-10-11T00:00:00.000Z",
  body: "please review",
  delivery: "mailbox",
  idempotencyKey: key,
  messageId: "m-1",
  target: BOB,
  threadId: "t-1",
  workflowId: WORKFLOW,
});

test("loop mailbox ack in a session without the supervisor's token moves the cursor and defers the V2 ACK to the server, instead of holding it forever", async () => {
  const root = scratch();
  const key = deriveSupervisorMessageV2DeliveryId(SENDER, WORKFLOW, 1);
  writeFileSync(
    mailboxPathFor(root, BOB),
    `${JSON.stringify(v2Envelope(key))}\n`
  );
  const configPath = join(root, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: { routePath: "/a2a" },
      hostname: "127.0.0.1",
      port: 9,
      supervisors: [
        {
          principal: "principal:bob",
          supervisorId: BOB,
          tokenEnv: "BOB_TOKEN",
        },
      ],
    }),
    { mode: 0o600 }
  );
  // The mailbox-only session: the config is here, its token is not.
  const result = await runMailboxCommandWithV2Ack(
    ["mailbox", "ack", "--id", BOB, "--root", root, "--key", key],
    { env: { HOME: root, LOOP_ORCHESTRATION_CONFIG: configPath } }
  );
  expect(result.consumedKeys).toEqual([key]);
  expect(result.heldKeys).toBeUndefined();
  expect(result.v2).toEqual({
    acknowledged: [],
    deferred: [
      {
        reason: "supervisor:bob's token environment BOB_TOKEN is not set",
        workflowId: WORKFLOW,
      },
    ],
    refused: [],
    workResultCompleted: false,
  });
  expect(
    runMailboxCommand(["mailbox", "receive", "--id", BOB, "--root", root])
      .messages
  ).toEqual([]);
});

test("fix9 still refuses a session that holds another supervisor's token: its V2 key is held, not deferred", async () => {
  const root = scratch();
  const key = deriveSupervisorMessageV2DeliveryId(SENDER, WORKFLOW, 1);
  writeFileSync(
    mailboxPathFor(root, BOB),
    `${JSON.stringify(v2Envelope(key))}\n`
  );
  const configPath = join(root, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: { routePath: "/a2a" },
      hostname: "127.0.0.1",
      port: 9,
      supervisors: [
        {
          principal: "principal:bob",
          supervisorId: BOB,
          tokenEnv: "BOB_TOKEN",
        },
        {
          principal: "principal:alice",
          supervisorId: "supervisor:alice",
          tokenEnv: "ALICE_TOKEN",
        },
      ],
    }),
    { mode: 0o600 }
  );
  const result = await runMailboxCommandWithV2Ack(
    ["mailbox", "ack", "--id", BOB, "--root", root, "--key", key],
    {
      env: {
        ALICE_TOKEN: "alice-fixture",
        BOB_TOKEN: "bob-fixture",
        HOME: root,
        LOOP_ORCHESTRATION_CONFIG: configPath,
      },
    }
  );
  expect(result.consumed).toBe(0);
  expect(result.heldKeys).toEqual([key]);
  expect(result.v2?.deferred).toBeUndefined();
  expect(result.v2?.refused[0]?.reason).toContain(
    "other supervisors' token variables (ALICE_TOKEN)"
  );
  expect(JSON.stringify(result)).not.toContain("fixture");
});

test("a route that was resolved but refused or unreachable still holds the key; only an unresolved route defers", async () => {
  const root = scratch();
  const key = deriveSupervisorMessageV2DeliveryId(SENDER, WORKFLOW, 1);
  writeFileSync(
    mailboxPathFor(root, BOB),
    `${JSON.stringify(v2Envelope(key))}\n`
  );
  const argv = ["mailbox", "ack", "--id", BOB, "--root", root, "--key", key];
  const unreachable = await runMailboxCommandWithV2Ack(argv, {
    acknowledgeV2: () => Promise.reject(new Error("server down")),
  });
  expect(unreachable.heldKeys).toEqual([key]);
  expect(unreachable.consumed).toBe(0);
  const refused = await runMailboxCommandWithV2Ack(argv, {
    acknowledgeV2: () =>
      Promise.resolve({
        acknowledged: [],
        refused: [{ reason: "assignment-denied", workflowId: WORKFLOW }],
        workResultCompleted: false,
      }),
  });
  expect(refused.heldKeys).toEqual([key]);
  const unresolved = await runMailboxCommandWithV2Ack(argv, {
    acknowledgeV2: () =>
      Promise.reject(new MailboxV2RouteUnresolvedError("no config here")),
  });
  expect(unresolved.consumedKeys).toEqual([key]);
  expect(unresolved.v2?.deferred).toEqual([
    { reason: "no config here", workflowId: WORKFLOW },
  ]);
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import { JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import {
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  agentCardFor,
  FROM_METADATA_KEY,
  SupervisorA2AAdapter,
} from "../../src/loop/a2a-supervisor-adapter";
import {
  SupervisorA2AExecutor,
  WORKFLOW_ID_METADATA_KEY,
  WORKFLOW_IDS_METADATA_KEY,
} from "../../src/loop/a2a-supervisor-executor";
import { SupervisorA2ARequestHandler } from "../../src/loop/a2a-supervisor-request-handler";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  MailboxSupervisorMessageDeliveryPort,
  mailboxPathFor,
} from "../../src/loop/supervisor-mailbox-delivery";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import { GovernedSupervisorMessageService } from "../../src/loop/supervisor-message-governance";
import { supervisorMessageWorkflowDefinition } from "../../src/loop/supervisor-message-workflow";
import { SupervisorOrchestrationRuntime } from "../../src/loop/supervisor-orchestration-runtime";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";

/**
 * A round trip through the SDK's OWN server, not through a local lookalike.
 *
 * Review's objection to the previous state was precise: the executor defined
 * its own request and event interfaces and cast its result, so "a real A2A
 * server can drive this" was structurally plausible and never demonstrated.
 * Here the SDK's `DefaultRequestHandler` subclass builds the RequestContext, assigns the
 * task id, runs the executor, drains the event bus and persists to its own task
 * store. Nothing in this file constructs a RequestContext by hand.
 *
 * Scope, stated so it is not read as more: in-process, no network, no
 * transport, no live service. The HTTP/JSON-RPC layer sits above
 * `A2ARequestHandler`, which is the seam exercised here.
 */
const SENDER = "supervisor:portfolio-coordinator";
const SENDER_PRINCIPAL = "principal:portfolio-coordinator";
const RECIPIENT = "supervisor:harness-desktop";
const RECIPIENT_PRINCIPAL = "principal:harness-desktop";
const TENANT = "tenant:a2a-round-trip";
const AT = "2026-09-20T05:00:00.000Z";

const POLICY = {
  claimTimeoutMs: 600_000,
  escalationTimeoutMs: 1_200_000,
  maxDeliveryAttempts: 3,
  retryDelayMs: 30_000,
};

const part = (value: string) => ({
  content: { $case: "text" as const, value },
  filename: "",
  mediaType: "",
  metadata: undefined,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  contextId: "round-trip",
  extensions: [],
  messageId: "a2a-round-trip-1",
  metadata: { [FROM_METADATA_KEY]: SENDER },
  parts: [part("A bounded request routed by the SDK's own handler.")],
  referenceTaskIds: [],
  role: Role.ROLE_USER,
  taskId: "",
  ...overrides,
});

const callerIs = (userName: string) =>
  new ServerCallContext({
    tenant: TENANT,
    user: { isAuthenticated: true, userName },
  });

const server = (root: string) => {
  const runtime = new SupervisorOrchestrationRuntime({
    governed: new GovernedSupervisorMessageService({
      authority: {
        decide: (request) => {
          const expected =
            request.operation === "receive" || request.operation === "cancel"
              ? SENDER_PRINCIPAL
              : RECIPIENT_PRINCIPAL;
          const allowed = request.principal === expected;
          return {
            allowed,
            authorityRef: "authority:round-trip",
            reasonCode: allowed ? "allowed" : "denied",
          };
        },
      },
      coordinator: new SupervisorMessageCoordinator(
        new InMemoryWorkflowPort({
          definitions: [supervisorMessageWorkflowDefinition],
          now: () => AT,
        }),
        new MailboxSupervisorMessageDeliveryPort({
          directory: {
            resolveMailbox: (id: string) => mailboxPathFor(root, id),
          },
          now: () => AT,
        })
      ),
      now: () => AT,
      receipts: { record: () => undefined },
    }),
    store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
  });
  const card = agentCardFor({
    description: "Harness engineering supervisor.",
    supervisorId: RECIPIENT,
    url: "http://127.0.0.1:0/a2a",
  });
  return {
    card,
    handler: new SupervisorA2ARequestHandler(
      card,
      new InMemoryTaskStore(),
      new SupervisorA2AExecutor({
        adapter: new SupervisorA2AAdapter({
          now: () => AT,
          policy: POLICY,
          runtime,
          supervisorId: RECIPIENT,
        }),
        now: () => AT,
      })
    ),
    runtime,
  };
};

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "a2a-round-trip-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const asTask = (result: Message | Task): Task => {
  // The handler returns a Message or a Task; this executor always produces a
  // Task, and saying so loudly beats a cast that hides a surprise.
  if (!("status" in result)) {
    throw new Error("expected the handler to return a Task, got a Message");
  }
  return result;
};

test("the SDK's own handler drives the executor end to end", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const result = await s.handler.sendMessage(
      {
        configuration: undefined,
        message: message(),
        metadata: undefined,
        tenant: "",
      },
      callerIs(SENDER_PRINCIPAL)
    );

    const task = asTask(result);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.contextId).toBe("round-trip");

    // The message really went through governance and the workflow into the
    // durable store, driven by the SDK rather than by a hand-built context.
    const stored = s.runtime.threads().threads[0]?.messages[0]?.item;
    expect(stored?.from).toBe(SENDER);
    expect(stored?.to).toBe(RECIPIENT);
    expect(stored?.phase).toBe("routed");
    // And the two identities are carried side by side.
    expect(task.metadata?.[WORKFLOW_ID_METADATA_KEY]).toBe(stored?.workflowId);
  });
});

test("the task the handler persisted can be fetched back by its own id", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const context = callerIs(SENDER_PRINCIPAL);
    const sent = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        context
      )
    );

    // getTask goes to the SDK's task store, which only has anything in it
    // because the handler drained our executor's events into it.
    const fetched = await s.handler.getTask(
      { historyLength: undefined, id: sent.id, tenant: "" },
      context
    );
    expect(fetched.id).toBe(sent.id);
    expect(fetched.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(fetched.metadata?.[WORKFLOW_ID_METADATA_KEY]).toBe(
      sent.metadata?.[WORKFLOW_ID_METADATA_KEY]
    );
  });
});

test("the handler streams the same outcome, terminating on its own", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const seen: string[] = [];
    let streamed: Task | undefined;
    for await (const event of s.handler.sendMessageStream(
      {
        configuration: undefined,
        message: message(),
        metadata: undefined,
        tenant: "",
      },
      callerIs(SENDER_PRINCIPAL)
    )) {
      const payload = event.payload;
      seen.push(payload?.$case ?? "none");
      if (payload?.$case === "task") {
        streamed = payload.value;
      }
    }

    // The stream ENDED, which is the part worth asserting: a refusal that
    // failed to settle the bus would hang this loop instead of failing it.
    expect(seen[0]).toBe("task");
    expect(streamed?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  });
});

test("a caller governance denies is refused through the handler, with nothing written", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const task = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        // Authenticated, but holds no grant to route anything.
        callerIs(RECIPIENT_PRINCIPAL)
      )
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(s.runtime.threads().threads).toHaveLength(0);
  });
});

test("the handler serves the agent card this adapter builds", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const card = await s.handler.getAgentCard();
    expect(card.name).toBe(RECIPIENT);
    expect(card.skills[0]?.id).toBe(`${RECIPIENT}:receive`);
  });
});

/**
 * Root's correction, pinned. A2A tasks are NOT per-request: a follow-up message
 * naming an existing task continues it. So "the protocol's id is a request id"
 * was wrong, and the real difference is narrower and still real — the SDK
 * assigns a fresh task id to a message that names no task, while our workflow
 * id is derived from the message content, so two independent sends of the same
 * message id are one workflow and two A2A tasks.
 */
test("two sends of the same message id are two A2A tasks but one workflow", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const context = callerIs(SENDER_PRINCIPAL);
    const request = {
      configuration: undefined,
      message: message(),
      metadata: undefined,
      tenant: "",
    };
    const first = asTask(await s.handler.sendMessage(request, context));
    const second = asTask(
      await s.handler.sendMessage({ ...request, message: message() }, context)
    );

    // Two distinct protocol tasks...
    expect(second.id).not.toBe(first.id);
    // ...naming the same unit of work, and only one durable message.
    expect(second.metadata?.[WORKFLOW_ID_METADATA_KEY]).toBe(
      first.metadata?.[WORKFLOW_ID_METADATA_KEY]
    );
    expect(
      s.runtime.threads().threads.flatMap((thread) => thread.messages)
    ).toHaveLength(1);
  });
});

/**
 * A follow-up turn: a different message naming an existing task. The protocol
 * allows one task to span several requests, so this is not an edge case.
 *
 * This caught a real bug. The first version of the executor wrote only the
 * current turn's workflow id into task metadata, so the SDK's task store was
 * last-write-wins: after a follow-up, the FIRST turn's workflow was unreachable
 * through the protocol even though its work was still live and still in the
 * durable store. The same clobbering applied to the task's history.
 */
test("a follow-up turn keeps the task and accumulates every workflow it started", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const ctx = callerIs(SENDER_PRINCIPAL);
    const first = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const follow = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message({
            messageId: "a2a-round-trip-2",
            taskId: first.id,
          }),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );

    // Same task, as the protocol requires.
    expect(follow.id).toBe(first.id);
    // Two turns, two workflows: the singular key names THIS turn...
    const firstWorkflow = first.metadata?.[WORKFLOW_ID_METADATA_KEY];
    const secondWorkflow = follow.metadata?.[WORKFLOW_ID_METADATA_KEY];
    expect(secondWorkflow).not.toBe(firstWorkflow);

    // ...and the chain keeps BOTH, oldest first. Without this the first
    // turn's work is orphaned behind a task that no longer mentions it.
    expect(follow.metadata?.[WORKFLOW_IDS_METADATA_KEY]).toEqual([
      firstWorkflow,
      secondWorkflow,
    ]);

    // The SDK's own store agrees, which is the thing a client would read.
    const fetched = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(fetched.metadata?.[WORKFLOW_IDS_METADATA_KEY]).toEqual([
      firstWorkflow,
      secondWorkflow,
    ]);
    expect(fetched.history).toHaveLength(2);

    // Both turns really are separate units of work in the durable store.
    const durable = s.runtime
      .threads()
      .threads.flatMap((thread) => thread.messages);
    expect(durable.map((entry) => entry.item.messageId).sort()).toEqual([
      "a2a-round-trip-1",
      "a2a-round-trip-2",
    ]);
  });
});

test("a malformed follow-up is rejected before task persistence so a later valid turn continues", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const ctx = callerIs(SENDER_PRINCIPAL);
    const first = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const beforeRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );

    // A second turn with no sender is malformed at the request boundary. It
    // must not become a terminal task event, because that would strand the
    // already-live first workflow and prohibit the later valid turn.
    await expect(
      s.handler.sendMessage(
        {
          configuration: undefined,
          message: message({
            messageId: "a2a-round-trip-refused",
            metadata: {},
            taskId: first.id,
          }),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    ).rejects.toBeInstanceOf(RequestMalformedError);

    const afterRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(afterRefusal).toEqual(beforeRefusal);
    expect(afterRefusal.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(afterRefusal.history?.map((entry) => entry.messageId)).toEqual([
      "a2a-round-trip-1",
    ]);

    // The malformed turn reaches neither the task history nor the durable
    // workflow projection.
    expect(
      s.runtime
        .threads()
        .threads.flatMap((thread) => thread.messages)
        .map((entry) => entry.item.messageId)
    ).toEqual(["a2a-round-trip-1"]);
    expect(afterRefusal.metadata?.[WORKFLOW_IDS_METADATA_KEY]).toEqual([
      first.metadata?.[WORKFLOW_ID_METADATA_KEY],
    ]);

    const third = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message({
            messageId: "a2a-round-trip-3",
            taskId: first.id,
          }),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const thirdWorkflow = third.metadata?.[WORKFLOW_ID_METADATA_KEY];
    expect(third.id).toBe(first.id);
    expect(third.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(third.metadata?.[WORKFLOW_IDS_METADATA_KEY]).toEqual([
      first.metadata?.[WORKFLOW_ID_METADATA_KEY],
      thirdWorkflow,
    ]);
    const afterThird = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(afterThird.history?.map((entry) => entry.messageId)).toEqual([
      "a2a-round-trip-1",
      "a2a-round-trip-3",
    ]);
    expect(
      s.runtime
        .threads()
        .threads.flatMap((thread) => thread.messages)
        .map((entry) => entry.item.messageId)
        .sort()
    ).toEqual(["a2a-round-trip-1", "a2a-round-trip-3"]);
  });
});

test("streaming rejects malformed requests before the SDK creates a task context", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const ctx = callerIs(SENDER_PRINCIPAL);
    const first = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const beforeRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );

    // This needs to throw while constructing the stream. An `async *`
    // override would defer the exception until iteration, outside transport
    // request-error handling, and would again allow the SDK to mutate first.
    expect(() =>
      s.handler.sendMessageStream(
        {
          configuration: undefined,
          message: message({ metadata: {}, taskId: first.id }),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    ).toThrow(RequestMalformedError);

    const afterRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(afterRefusal).toEqual(beforeRefusal);
  });
});

test("the SDK JSON-RPC transport maps a malformed follow-up without mutating its task", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const ctx = callerIs(SENDER_PRINCIPAL);
    const first = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const beforeRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );

    const response = await new JsonRpcTransportHandler(s.handler).handle(
      {
        id: "a2a-json-rpc-refusal",
        jsonrpc: "2.0",
        method: "SendMessage",
        params: {
          configuration: undefined,
          message: Message.toJSON(message({ metadata: {}, taskId: first.id })),
          metadata: undefined,
          tenant: "",
        },
      },
      ctx
    );
    if (Symbol.asyncIterator in response || !("error" in response)) {
      throw new Error("expected a non-streaming JSON-RPC error response");
    }
    expect(response.error).toMatchObject({
      code: -32_602,
      message: expect.stringContaining(FROM_METADATA_KEY),
    });

    const afterRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(afterRefusal).toEqual(beforeRefusal);
  });
});

test("the SDK JSON-RPC client receives the native refusal through its transport seam", async () => {
  await withRoot(async (root) => {
    const s = server(root);
    const ctx = callerIs(SENDER_PRINCIPAL);
    const first = asTask(
      await s.handler.sendMessage(
        {
          configuration: undefined,
          message: message(),
          metadata: undefined,
          tenant: "",
        },
        ctx
      )
    );
    const beforeRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    const handler = new JsonRpcTransportHandler(s.handler);
    const fetchImpl: typeof fetch = Object.assign(
      async (...[_input, init]: Parameters<typeof fetch>) => {
        if (typeof init?.body !== "string") {
          throw new Error("the SDK client must send a JSON-RPC request body");
        }
        const response = await handler.handle(
          init.body,
          callerIs(SENDER_PRINCIPAL)
        );
        if (Symbol.asyncIterator in response) {
          throw new Error("this non-streaming request unexpectedly streamed");
        }
        return Response.json(response);
      },
      { preconnect: fetch.preconnect }
    );
    const client = await new JsonRpcTransportFactory({ fetchImpl }).create(
      "http://a2a.invalid/loopback",
      s.card
    );
    await expect(
      client.sendMessage({
        configuration: undefined,
        message: message({ metadata: {}, taskId: first.id }),
        metadata: undefined,
        tenant: "",
      })
    ).rejects.toMatchObject({ reason: "INVALID_PARAMS" });

    const afterRefusal = await s.handler.getTask(
      { historyLength: undefined, id: first.id, tenant: "" },
      ctx
    );
    expect(afterRefusal).toEqual(beforeRefusal);
  });
});

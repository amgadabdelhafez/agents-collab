import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import {
  DefaultExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  type A2AInboundMessage,
  FROM_METADATA_KEY,
  SupervisorA2AAdapter,
} from "../../src/loop/a2a-supervisor-adapter";
import {
  SupervisorA2AExecutor,
  TASK_STATE_METADATA_KEY,
  WORKFLOW_ID_METADATA_KEY,
} from "../../src/loop/a2a-supervisor-executor";
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
 * Stage 2: the executor a real A2A transport would drive, tested by calling it
 * directly. No network, no server, no live activation.
 *
 * The failure controls are the point of most of this file. A transport has to
 * answer its client whatever happens, so every refusal has to arrive as a task
 * on the bus and the bus has to be settled exactly once — a refusal that throws
 * past the transport leaves a client waiting on a stream that will never close.
 */
const SENDER = "supervisor:portfolio-coordinator";
const SENDER_PRINCIPAL = "principal:portfolio-coordinator";
const RECIPIENT = "supervisor:harness-desktop";
const RECIPIENT_PRINCIPAL = "principal:harness-desktop";
const TENANT = "tenant:a2a-executor";
const AT = "2026-09-20T04:00:00.000Z";
const SERVER_TASK_ID = "a2a-task-assigned-by-the-server";

const POLICY = {
  claimTimeoutMs: 600_000,
  escalationTimeoutMs: 1_200_000,
  maxDeliveryAttempts: 3,
  retryDelayMs: 30_000,
};

/**
 * Real SDK objects, not lookalikes. Review flagged that local stand-ins made
 * "a real server can drive this" structurally plausible rather than
 * demonstrated, and the scoped typecheck confirmed it: the previous fakes were
 * missing `taskId`, `role`, `extensions` and `referenceTaskIds` on the message
 * and most of `ServerCallContext`.
 */
const authenticated = (userName: string) =>
  new ServerCallContext({
    tenant: TENANT,
    user: { isAuthenticated: true, userName },
  });

const unauthenticated = () =>
  new ServerCallContext({
    tenant: TENANT,
    user: { isAuthenticated: false, userName: "anonymous" },
  });

const contextFor = (input: {
  context: ServerCallContext;
  message: Message;
  taskId: string;
}) =>
  new RequestContext(
    {
      configuration: undefined,
      message: input.message,
      metadata: undefined,
      tenant: TENANT,
    },
    input.taskId,
    input.message.contextId,
    input.context
  );

/**
 * A2A's Part carries metadata, filename and mediaType alongside its content,
 * and all three are required. Built here so a test part is a real Part rather
 * than a convenient subset the compiler would reject.
 */
const part = (content: A2AInboundMessage["parts"][number]["content"]) => ({
  content,
  filename: "",
  mediaType: "",
  metadata: undefined,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  contextId: "a2a-thread",
  extensions: [],
  messageId: "a2a-exec-1",
  metadata: { [FROM_METADATA_KEY]: SENDER },
  parts: [part({ $case: "text", value: "A bounded request." })],
  referenceTaskIds: [],
  role: Role.ROLE_USER,
  taskId: "",
  ...overrides,
});

/**
 * The SDK's own event bus, with listeners attached so what a transport would
 * see is assertable. Using the real bus rather than a recorder shaped like one
 * is the point: the previous stand-in was not assignable to ExecutionEventBus
 * at all, which the scoped typecheck caught.
 */
const recordingBus = () => {
  const bus = new DefaultExecutionEventBus();
  const published: Task[] = [];
  let finishedCount = 0;
  bus.on("event", (event) => {
    if (event.kind === "task") {
      published.push(event.data);
    }
  });
  bus.on("finished", () => {
    finishedCount += 1;
  });
  return {
    bus,
    get finishedCount() {
      return finishedCount;
    },
    published,
  };
};

const world = (root: string) => {
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
            authorityRef: "authority:a2a-exec",
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
  return {
    executor: new SupervisorA2AExecutor({
      adapter: new SupervisorA2AAdapter({
        now: () => AT,
        policy: POLICY,
        runtime,
        supervisorId: RECIPIENT,
      }),
      now: () => AT,
    }),
    runtime,
  };
};

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "a2a-executor-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

test("a routed request publishes one task and settles the bus", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: authenticated(SENDER_PRINCIPAL),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );

    expect(recorder.published).toHaveLength(1);
    expect(recorder.finishedCount).toBe(1);
    const [task] = recorder.published;
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task?.contextId).toBe("a2a-thread");
    // And it really routed: the message is in the durable store.
    expect(w.runtime.threads().threads).toHaveLength(1);
  });
});

/**
 * The identity finding, pinned. A2A assigns the task id per request; our
 * workflow id is derived from the message. Neither may silently stand in for
 * the other, so the task reports the server's id and carries ours in metadata.
 */
test("the task reports the server's id and carries the derived workflow id beside it", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: authenticated(SENDER_PRINCIPAL),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );

    const [task] = recorder.published;
    expect(task?.id).toBe(SERVER_TASK_ID);
    const workflowId = task?.metadata?.[WORKFLOW_ID_METADATA_KEY];
    expect(workflowId).toMatch(/^supervisor-message:[0-9a-f]{64}$/);
    // They are genuinely different identities, which is the whole point.
    expect(workflowId).not.toBe(SERVER_TASK_ID);
    expect(w.runtime.threads().threads[0]?.messages[0]?.item.workflowId).toBe(
      workflowId
    );
  });
});

test("an unauthenticated caller is refused and nothing is written", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: unauthenticated(),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );

    const [task] = recorder.published;
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(String(task?.metadata?.[TASK_STATE_METADATA_KEY])).toContain(
      "authenticated"
    );
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

test("a context with no user at all is refused, not defaulted", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: new ServerCallContext({}),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );
    expect(recorder.published[0]?.status?.state).toBe(
      TaskState.TASK_STATE_FAILED
    );
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

test("an authenticated caller without a tenant is refused, not defaulted", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: new ServerCallContext({
          user: { isAuthenticated: true, userName: SENDER_PRINCIPAL },
        }),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );
    expect(recorder.published[0]?.status?.state).toBe(
      TaskState.TASK_STATE_FAILED
    );
    expect(
      String(recorder.published[0]?.metadata?.[TASK_STATE_METADATA_KEY])
    ).toContain("tenant");
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

/**
 * Failure controls. Each of these is a refusal the adapter makes for a
 * different reason; what matters here is that the TRANSPORT always gets a task
 * and a settled bus, never an exception and never a stream left open.
 */
const refusals: [string, Partial<Message>, string][] = [
  [
    "an unsupported part",
    { parts: [part({ $case: "data", value: {} })] },
    "data",
  ],
  ["no text", { parts: [] }, "text part"],
  ["no sender", { metadata: {} }, FROM_METADATA_KEY],
];

for (const [label, overrides, expected] of refusals) {
  test(`a request with ${label} fails as a task, with the bus settled once`, async () => {
    await withRoot(async (root) => {
      const w = world(root);
      const recorder = recordingBus();
      await w.executor.execute(
        contextFor({
          context: authenticated(SENDER_PRINCIPAL),
          message: message(overrides),
          taskId: SERVER_TASK_ID,
        }),
        recorder.bus
      );

      expect(recorder.published).toHaveLength(1);
      expect(recorder.finishedCount).toBe(1);
      expect(recorder.published[0]?.status?.state).toBe(
        TaskState.TASK_STATE_FAILED
      );
      expect(
        String(recorder.published[0]?.metadata?.[TASK_STATE_METADATA_KEY])
      ).toContain(expected);
      expect(w.runtime.threads().threads).toHaveLength(0);
    });
  });
}

test("a caller governance denies fails as a task rather than throwing past the transport", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const recorder = recordingBus();
    await w.executor.execute(
      contextFor({
        context: authenticated(RECIPIENT_PRINCIPAL),
        message: message(),
        taskId: SERVER_TASK_ID,
      }),
      recorder.bus
    );

    expect(recorder.published[0]?.status?.state).toBe(
      TaskState.TASK_STATE_FAILED
    );
    expect(recorder.finishedCount).toBe(1);
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

/**
 * Cancellation is refused rather than faked. Cancel is a governed operation
 * held by the sender's principal, and the SDK's cancel signature carries no
 * principal at all, so accepting it would either bypass governance or report a
 * cancellation that never happened.
 */
test("cancelTask refuses instead of reporting a cancellation it did not perform", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.executor.cancelTask(SERVER_TASK_ID, recordingBus().bus)
    ).rejects.toThrow("not implemented");
  });
});

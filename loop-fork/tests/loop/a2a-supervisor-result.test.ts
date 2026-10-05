import { expect, test } from "bun:test";
import { type Task, TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import { publishSupervisorA2AAcceptedResult } from "../../src/loop/a2a-supervisor-result";

test("accepted graph result is distinct from ACK, verifies artifacts and preserves follow-up completion", async () => {
  class AtomicFixtureStore extends InMemoryTaskStore {
    queue = Promise.resolve();
    update(
      id: string,
      context: ServerCallContext,
      transform: (current: Task | undefined) => Task
    ): Promise<void> {
      const next = this.queue.then(async () => {
        await this.save(transform(await this.load(id, context)), context);
      });
      this.queue = next.catch(() => {
        // Keep the fixture queue available after an individually refused update.
      });
      return next;
    }
  }
  const store = new AtomicFixtureStore();
  const context = new ServerCallContext({
    tenant: "tenant:one",
    user: { isAuthenticated: true, userName: "principal:sender" },
  });
  await store.save(
    {
      id: "task:one",
      contextId: "context:one",
      history: [],
      artifacts: [],
      metadata: { [WORKFLOW_IDS_METADATA_KEY]: ["message:one", "message:two"] },
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: "2026-10-05T06:00:00Z",
        message: undefined,
      },
    },
    context
  );
  let phase = "claimed";
  let verified = true;
  const input = {
    binding: {
      a2aTaskId: "task:one",
      messageWorkflowId: "message:one",
      graphWorkflowId: "graph:one",
      graphTaskId: "node:one",
      recipient: "worker:one",
    },
    context,
    store,
    now: () => "2026-10-05T07:00:00Z",
    verifyArtifact: () => Promise.resolve(verified),
    workflows: {
      query: () =>
        Promise.resolve({
          revision: 4,
          status: "running" as const,
          workflowId: "graph:one",
          value: {
            schema: "task-graph-projection.v1",
            nodes: [
              {
                taskId: "node:one",
                phase,
                workerId: "worker:one",
                acceptanceReceipts: [
                  {
                    checkId: "check:one",
                    artifactRef: `artifact://sha256/${"a".repeat(64)}`,
                  },
                ],
              },
            ],
          },
        }),
    },
  };
  await expect(publishSupervisorA2AAcceptedResult(input)).rejects.toThrow(
    "not accepted"
  );
  phase = "succeeded";
  verified = false;
  await expect(publishSupervisorA2AAcceptedResult(input)).rejects.toThrow(
    "unverified"
  );
  expect((await store.load("task:one", context))?.artifacts).toHaveLength(0);
  verified = true;
  await Promise.all([
    publishSupervisorA2AAcceptedResult(input),
    publishSupervisorA2AAcceptedResult({
      ...input,
      binding: { ...input.binding, messageWorkflowId: "message:two" },
    }),
  ]);
  expect((await store.load("task:one", context))?.artifacts).toHaveLength(2);
  expect((await store.load("task:one", context))?.status?.state).toBe(
    TaskState.TASK_STATE_COMPLETED
  );
  // Reset to exercise the independently ordered publication contract below.
  const completed = await store.load("task:one", context);
  if (!completed) {
    throw new Error("Fixture task missing");
  }
  await store.save(
    {
      ...completed,
      artifacts: [],
      status: {
        ...completed.status,
        state: TaskState.TASK_STATE_SUBMITTED,
      },
    },
    context
  );
  await publishSupervisorA2AAcceptedResult(input);
  expect((await store.load("task:one", context))?.status?.state).toBe(
    TaskState.TASK_STATE_SUBMITTED
  );
  await publishSupervisorA2AAcceptedResult(input);
  expect((await store.load("task:one", context))?.artifacts).toHaveLength(1);
  await publishSupervisorA2AAcceptedResult({
    ...input,
    binding: { ...input.binding, messageWorkflowId: "message:two" },
  });
  expect((await store.load("task:one", context))?.status?.state).toBe(
    TaskState.TASK_STATE_COMPLETED
  );
  expect((await store.load("task:one", context))?.artifacts).toHaveLength(2);
});

import { expect, test } from "bun:test";
import { type Task, TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import {
  assertSupervisorA2AResultGraphTask,
  publishSupervisorA2AAcceptedResult,
} from "../../src/loop/a2a-supervisor-result";
import type { JsonValue } from "../../src/loop/workflow-port";

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
  // A follow-up turn on the same A2A task is the same unit of work: one graph
  // task may complete every message workflow of that task. Reuse across A2A
  // tasks is refused by the ledger's graph task reservation instead.
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

class AtomicStore extends InMemoryTaskStore {
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

const resultContext = new ServerCallContext({
  tenant: "tenant:one",
  user: { isAuthenticated: true, userName: "principal:sender" },
});
const receiptRef = `artifact://sha256/${"a".repeat(64)}`;
const succeededGraph = (...taskIds: string[]) => ({
  query: () =>
    Promise.resolve({
      revision: 4,
      status: "running" as const,
      workflowId: "graph:one",
      value: {
        schema: "task-graph-projection.v1",
        nodes: taskIds.map((taskId) => ({
          taskId,
          phase: "succeeded",
          workerId: "worker:one",
          acceptanceReceipts: [
            { checkId: "check:one", artifactRef: receiptRef },
          ],
        })),
      },
    }),
});
const submittedTask = (workflowIds: unknown): Task => ({
  id: "task:one",
  contextId: "context:one",
  history: [],
  artifacts: [],
  metadata: { [WORKFLOW_IDS_METADATA_KEY]: workflowIds },
  status: {
    state: TaskState.TASK_STATE_SUBMITTED,
    timestamp: "2026-10-05T06:00:00Z",
    message: undefined,
  },
});
const resultBinding = {
  a2aTaskId: "task:one",
  messageWorkflowId: "message:one",
  graphWorkflowId: "graph:one",
  graphTaskId: "node:one",
  recipient: "worker:one",
};

test("an acceptance artifact verifies only for the graph task it was recorded for", async () => {
  const store = new AtomicStore();
  await store.save(submittedTask(["message:one"]), resultContext);
  const asked: unknown[] = [];
  const input = {
    binding: { ...resultBinding, graphTaskId: "node:other" },
    context: resultContext,
    store,
    now: () => "2026-10-05T07:00:00Z",
    // Host allowlist: this artifact is evidence for graph:one/node:one only.
    verifyArtifact: (
      reference: string,
      target?: { graphTaskId: string; graphWorkflowId: string }
    ) => {
      asked.push(target);
      return Promise.resolve(
        reference === receiptRef &&
          target?.graphWorkflowId === "graph:one" &&
          target.graphTaskId === "node:one"
      );
    },
    workflows: succeededGraph("node:one", "node:other"),
  };
  await expect(publishSupervisorA2AAcceptedResult(input)).rejects.toThrow(
    "unverified"
  );
  expect((await store.load("task:one", resultContext))?.artifacts).toHaveLength(
    0
  );
  await publishSupervisorA2AAcceptedResult({
    ...input,
    binding: resultBinding,
  });
  expect(asked).toEqual([
    { graphWorkflowId: "graph:one", graphTaskId: "node:other" },
    { graphWorkflowId: "graph:one", graphTaskId: "node:one" },
  ]);
  expect((await store.load("task:one", resultContext))?.status?.state).toBe(
    TaskState.TASK_STATE_COMPLETED
  );
});

test("empty or malformed workflow ids never complete the A2A task", async () => {
  const publish = (store: AtomicStore) =>
    publishSupervisorA2AAcceptedResult({
      binding: resultBinding,
      context: resultContext,
      store,
      now: () => "2026-10-05T07:00:00Z",
      verifyArtifact: () => Promise.resolve(true),
      workflows: succeededGraph("node:one"),
    });
  for (const workflowIds of [
    ["message:one", 7],
    ["message:one", ""],
    ["message:one", null],
  ]) {
    const store = new AtomicStore();
    await store.save(submittedTask(workflowIds), resultContext);
    await expect(publish(store)).rejects.toThrow("workflow ids");
    const task = await store.load("task:one", resultContext);
    expect(task?.artifacts).toHaveLength(0);
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  }
  // The pre-check sees this message's workflow, but the atomic update then
  // observes an emptied or malformed list. That must refuse, never vacuously
  // complete the task because `[].every(...)` is true.
  for (const workflowIds of [[], undefined, "message:one"]) {
    const store = new AtomicStore();
    await store.save(submittedTask(workflowIds), resultContext);
    const stored = store.load.bind(store);
    let first = true;
    store.load = async (id, context) => {
      const task = await stored(id, context);
      if (first && task) {
        first = false;
        return {
          ...task,
          metadata: { [WORKFLOW_IDS_METADATA_KEY]: ["message:one"] },
        };
      }
      return task;
    };
    await expect(publish(store)).rejects.toThrow("workflow ids");
    const task = await stored("task:one", resultContext);
    expect(task?.artifacts).toHaveLength(0);
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  }
});

test("malformed workflow ids are refused before the graph or any artifact is consulted", async () => {
  for (const workflowIds of [
    ["message:one", 7],
    ["message:one", ""],
    [],
    "message:one",
  ]) {
    const consulted: string[] = [];
    const store = new AtomicStore();
    await store.save(submittedTask(workflowIds), resultContext);
    const graph = succeededGraph("node:one");
    await expect(
      publishSupervisorA2AAcceptedResult({
        binding: resultBinding,
        context: resultContext,
        store,
        now: () => "2026-10-05T07:00:00Z",
        verifyArtifact: () => {
          consulted.push("artifact");
          return Promise.resolve(true);
        },
        workflows: {
          query: () => {
            consulted.push("graph");
            return graph.query();
          },
        },
      })
    ).rejects.toThrow();
    expect(consulted).toEqual([]);
    expect((await store.load("task:one", resultContext))?.artifacts).toEqual(
      []
    );
  }
});

test("binding refuses a graph that does not hold this recipient's task", async () => {
  const graph = (value: JsonValue) => ({
    query: () =>
      Promise.resolve({
        revision: 1,
        status: "running" as const,
        workflowId: "graph:one",
        value,
      }),
  });
  const node = (taskId: string, workerId: string | null) => ({
    schema: "task-graph-projection.v1",
    nodes: [{ taskId, workerId, phase: "ready", acceptanceReceipts: [] }],
  });
  const check = (value: JsonValue) =>
    assertSupervisorA2AResultGraphTask({
      binding: resultBinding,
      workflows: graph(value),
    });
  await expect(check(node("node:one", "worker:other"))).rejects.toThrow(
    "unrelated"
  );
  await expect(check(node("node:elsewhere", "worker:one"))).rejects.toThrow(
    "unrelated"
  );
  await expect(check({ schema: "other", nodes: [] })).rejects.toThrow(
    "invalid"
  );
  await expect(check(node("node:one", null))).resolves.toBeUndefined();
  await expect(check(node("node:one", "worker:one"))).resolves.toBeUndefined();
});

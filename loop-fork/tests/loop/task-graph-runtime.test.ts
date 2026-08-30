import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { TaskGraphRuntime } from "../../src/loop/task-graph-runtime";
import {
  TASK_GRAPH_WORKFLOW_TYPE,
  taskGraphWorkflowDefinition,
} from "../../src/loop/task-graph-workflow";

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

const input = {
  graphId: "runtime-graph",
  nodes: [
    {
      acceptanceChecks: [{ checkId: "task-a:test", kind: "test" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: artifact("a"),
      taskId: "task-a",
      writeScopes: ["loop-fork/src/a"],
    },
  ],
  schema: TASK_GRAPH_WORKFLOW_TYPE,
};

describe("TaskGraphRuntime", () => {
  test("wraps canonical workflow creation, readiness, ownership, and completion", async () => {
    const workflows = new InMemoryWorkflowPort({
      definitions: [taskGraphWorkflowDefinition],
      now: () => "2026-08-30T10:00:00.000Z",
    });
    const runtime = new TaskGraphRuntime({ workflows });
    await runtime.start({
      input,
      requestId: "start-1",
      workflowId: "task-graph:runtime",
    });
    expect((await runtime.ready("task-graph:runtime")).value).toEqual([
      "task-a",
    ]);
    await runtime.claim({
      requestId: "claim-1",
      taskId: "task-a",
      workerId: "worker:harness",
      workflowId: "task-graph:runtime",
    });
    await runtime.begin({
      requestId: "begin-1",
      taskId: "task-a",
      workerId: "worker:harness",
      workflowId: "task-graph:runtime",
    });
    await runtime.complete({
      payload: {
        receipts: [{ artifactRef: artifact("b"), checkId: "task-a:test" }],
        taskId: "task-a",
        workerId: "worker:harness",
      },
      requestId: "complete-1",
      workflowId: "task-graph:runtime",
    });
    expect(await runtime.status("task-graph:runtime")).toMatchObject({
      status: "completed",
      value: { readyTaskIds: [] },
    });
  });
});

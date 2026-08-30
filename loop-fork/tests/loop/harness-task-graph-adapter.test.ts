import { expect, test } from "bun:test";
import { parseHarnessTaskGraph } from "../../src/loop/harness-task-graph-adapter";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { TaskGraphRuntime } from "../../src/loop/task-graph-runtime";
import { taskGraphWorkflowDefinition } from "../../src/loop/task-graph-workflow";

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

const task = (taskId: string, dependencies: string[], digit: string) => ({
  acceptanceChecks: [{ checkId: `${taskId}:test`, kind: "test" }],
  authorityGates: [],
  dependencies,
  ownerRepository: "agents-collab",
  readScopes: ["loop-fork/src"],
  specArtifactRef: artifact(digit),
  taskId,
  writeScopes: [`loop-fork/src/${taskId}`],
});

test("Harness graph adapter admits only dependency-ready tasks", async () => {
  const workflows = new InMemoryWorkflowPort({
    definitions: [taskGraphWorkflowDefinition],
  });
  const runtime = new TaskGraphRuntime({ workflows });
  const input = parseHarnessTaskGraph({
    graphId: "overnight-orchestration",
    nodes: [
      task("message-engine", ["shared-auth"], "b"),
      task("shared-auth", [], "a"),
    ],
    schema: "harness-task-graph.v1",
  });
  await runtime.start({
    input,
    requestId: "start-1",
    workflowId: "task-graph:overnight-orchestration",
  });
  expect(
    await runtime.ready("task-graph:overnight-orchestration")
  ).toMatchObject({ value: ["shared-auth"] });
  expect(() =>
    runtime.claim({
      requestId: "claim-too-early",
      taskId: "message-engine",
      workerId: "principal:harness",
      workflowId: "task-graph:overnight-orchestration",
    })
  ).toThrow("not ready");
});

test("Harness graph adapter rejects duplicate, missing, and cyclic dependencies", () => {
  const duplicate = {
    graphId: "duplicate",
    nodes: [task("same", [], "a"), task("same", [], "b")],
    schema: "harness-task-graph.v1",
  };
  expect(() => parseHarnessTaskGraph(duplicate)).toThrow("must be unique");

  const workflows = new InMemoryWorkflowPort({
    definitions: [taskGraphWorkflowDefinition],
  });
  const runtime = new TaskGraphRuntime({ workflows });
  expect(() =>
    runtime.start({
      input: parseHarnessTaskGraph({
        graphId: "cycle",
        nodes: [task("a", ["b"], "a"), task("b", ["a"], "b")],
        schema: "harness-task-graph.v1",
      }),
      requestId: "cycle-start",
      workflowId: "task-graph:cycle",
    })
  ).toThrow("dependency cycle");
});

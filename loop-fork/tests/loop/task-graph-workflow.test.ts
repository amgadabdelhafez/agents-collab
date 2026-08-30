import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  TASK_GRAPH_WORKFLOW_TYPE,
  taskGraphWorkflowDefinition,
} from "../../src/loop/task-graph-workflow";
import type { JsonObject } from "../../src/loop/workflow-port";

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

const artifactDigitForTask = (taskId: string): string => {
  if (taskId === "a") {
    return "a";
  }
  if (taskId === "b") {
    return "b";
  }
  return "c";
};

const node = (
  taskId: string,
  dependencies: string[],
  writeScopes: string[],
  authorityGates: string[] = []
): JsonObject => ({
  acceptanceChecks: [
    { checkId: `${taskId}:review`, kind: "review" },
    { checkId: `${taskId}:test`, kind: "test" },
  ],
  authorityGates,
  dependencies,
  ownerRepository: "agents-collab",
  readScopes: ["loop-fork/src"],
  specArtifactRef: artifact(artifactDigitForTask(taskId)),
  taskId,
  writeScopes,
});

const validGraph = (): JsonObject => ({
  graphId: "overnight-orchestration",
  nodes: [
    node("a", [], ["loop-fork/src/shared"], ["founder-authority"]),
    node("b", ["a"], ["loop-fork/src/shared/consumer"]),
    node("c", [], ["loop-fork/src/independent"]),
  ],
  schema: TASK_GRAPH_WORKFLOW_TYPE,
});

const portFor = () =>
  new InMemoryWorkflowPort({
    definitions: [taskGraphWorkflowDefinition],
    now: () => "2026-08-30T08:00:00.000Z",
  });

const start = (port = portFor(), input = validGraph()) => {
  port.start({
    input,
    requestId: "start-1",
    workflowId: "task-graph-1",
    workflowType: TASK_GRAPH_WORKFLOW_TYPE,
  });
  return port;
};

const status = (port: InMemoryWorkflowPort) =>
  port.query({ name: "status", workflowId: "task-graph-1" }).value as {
    nodes: Array<{
      blockedBy: string[];
      phase: string;
      taskId: string;
      workerId: null | string;
    }>;
    readyTaskIds: string[];
  };

const signal = (
  port: InMemoryWorkflowPort,
  requestId: string,
  name: string,
  payload: JsonObject
) =>
  port.signal({
    name,
    payload,
    requestId,
    workflowId: "task-graph-1",
  });

const complete = (port: InMemoryWorkflowPort, taskId: string): void => {
  signal(port, `${taskId}-claim`, "claim", {
    taskId,
    workerId: `worker:${taskId}`,
  });
  signal(port, `${taskId}-start`, "start", {
    taskId,
    workerId: `worker:${taskId}`,
  });
  signal(port, `${taskId}-complete`, "complete", {
    receipts: [
      { artifactRef: artifact("d"), checkId: `${taskId}:review` },
      { artifactRef: artifact("e"), checkId: `${taskId}:test` },
    ],
    taskId,
    workerId: `worker:${taskId}`,
  });
};

describe("canonical task graph workflow", () => {
  test("admits only authority-ready roots and unlocks dependencies after exact receipts", () => {
    const port = start();
    expect(status(port).readyTaskIds).toEqual(["c"]);
    expect(
      status(port).nodes.find((entry) => entry.taskId === "a")?.blockedBy
    ).toEqual(["authority:founder-authority"]);

    signal(port, "gate-a", "satisfy_gate", {
      artifactRef: artifact("f"),
      gateId: "founder-authority",
      taskId: "a",
    });
    expect(status(port).readyTaskIds).toEqual(["a", "c"]);
    complete(port, "a");
    expect(status(port).readyTaskIds).toEqual(["b", "c"]);
    complete(port, "b");
    complete(port, "c");
    expect(port.inspect("task-graph-1").status).toBe("completed");
  });

  test("refuses claim-before-ready and incomplete or reordered acceptance receipts", () => {
    const port = start();
    expect(() =>
      signal(port, "claim-a", "claim", {
        taskId: "a",
        workerId: "worker:a",
      })
    ).toThrow("task a is not ready");
    signal(port, "claim-c", "claim", {
      taskId: "c",
      workerId: "worker:c",
    });
    signal(port, "start-c", "start", {
      taskId: "c",
      workerId: "worker:c",
    });
    expect(() =>
      signal(port, "complete-c", "complete", {
        receipts: [{ artifactRef: artifact("d"), checkId: "c:test" }],
        taskId: "c",
        workerId: "worker:c",
      })
    ).toThrow("exact acceptance receipt set");
    expect(
      status(port).nodes.find((entry) => entry.taskId === "c")?.phase
    ).toBe("running");
  });

  test("blocks transitive descendants after failure while independent branches remain ready", () => {
    const port = start();
    signal(port, "gate-a", "satisfy_gate", {
      artifactRef: artifact("f"),
      gateId: "founder-authority",
      taskId: "a",
    });
    signal(port, "claim-a", "claim", {
      taskId: "a",
      workerId: "worker:a",
    });
    signal(port, "fail-a", "fail", {
      failureCode: "tests-failed",
      taskId: "a",
      workerId: "worker:a",
    });
    const projection = status(port);
    expect(
      projection.nodes.find((entry) => entry.taskId === "b")
    ).toMatchObject({
      blockedBy: ["failed:a"],
      phase: "blocked",
    });
    expect(projection.readyTaskIds).toEqual(["c"]);
    expect(port.inspect("task-graph-1").status).toBe("running");
  });

  test("replays a gate receipt by request identity without advancing revision", () => {
    const port = start();
    const command = {
      artifactRef: artifact("f"),
      gateId: "founder-authority",
      taskId: "a",
    };
    const first = signal(port, "gate-a", "satisfy_gate", command);
    const replay = signal(port, "gate-a", "satisfy_gate", command);
    expect(replay).toMatchObject({ replayed: true, revision: first.revision });
  });

  test("rejects cycles, unknown edges, unsafe scopes, and unordered overlapping writers before creation", () => {
    const cases: JsonObject[] = [
      {
        ...validGraph(),
        nodes: [node("a", ["b"], ["src/a"]), node("b", ["a"], ["src/b"])],
      },
      { ...validGraph(), nodes: [node("a", ["missing"], ["src/a"])] },
      { ...validGraph(), nodes: [node("a", [], ["../escape"])] },
      {
        ...validGraph(),
        nodes: [
          node("a", [], ["src/shared"]),
          node("b", [], ["src/shared/child"]),
        ],
      },
    ];
    for (const [index, input] of cases.entries()) {
      const port = portFor();
      expect(() =>
        port.start({
          input,
          requestId: `invalid-${index}`,
          workflowId: `invalid-${index}`,
          workflowType: TASK_GRAPH_WORKFLOW_TYPE,
        })
      ).toThrow();
      expect(() => port.inspect(`invalid-${index}`)).toThrow("not found");
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { TASK_GRAPH_WORKFLOW_TYPE } from "../../src/loop/task-graph-workflow";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import type { JsonObject } from "../../src/loop/workflow-port";

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

const graphInput: JsonObject = {
  graphId: "temporal-dag-proof",
  nodes: [
    {
      acceptanceChecks: [{ checkId: "a:test", kind: "test" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: artifact("a"),
      taskId: "a",
      writeScopes: ["loop-fork/src/a"],
    },
    {
      acceptanceChecks: [{ checkId: "b:review", kind: "review" }],
      authorityGates: ["release-authority"],
      dependencies: ["a"],
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: artifact("b"),
      taskId: "b",
      writeScopes: ["loop-fork/src/b"],
    },
  ],
  schema: TASK_GRAPH_WORKFLOW_TYPE,
};

describe("Temporal task graph workflow", () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let port: TemporalWorkflowPort;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `task-graph-${process.pid}`;
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath: new URL(
        "../../src/loop/temporal-workflow.ts",
        import.meta.url
      ).pathname,
    });
    workerRun = worker.run();
    port = new TemporalWorkflowPort(environment.client.workflow, {
      now: () => "2026-08-30T09:00:00.000Z",
      taskQueue,
    });
  });

  afterAll(async () => {
    if (worker.getState() === "RUNNING") {
      worker.shutdown();
    }
    await workerRun;
    await environment.teardown();
  });

  test("durably dispatches the graph definition and unlocks only satisfied nodes", async () => {
    const workflowId = `temporal-task-graph-${process.pid}`;
    await port.start({
      input: graphInput,
      requestId: "start-1",
      workflowId,
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    });
    expect((await port.query({ name: "ready", workflowId })).value).toEqual([
      "a",
    ]);
    await port.signal({
      name: "claim",
      payload: { taskId: "a", workerId: "worker:a" },
      requestId: "claim-a",
      workflowId,
    });
    await port.signal({
      name: "start",
      payload: { taskId: "a", workerId: "worker:a" },
      requestId: "start-a",
      workflowId,
    });
    await port.signal({
      name: "complete",
      payload: {
        receipts: [{ artifactRef: artifact("c"), checkId: "a:test" }],
        taskId: "a",
        workerId: "worker:a",
      },
      requestId: "complete-a",
      workflowId,
    });
    expect((await port.query({ name: "ready", workflowId })).value).toEqual([]);
    await port.signal({
      name: "satisfy_gate",
      payload: {
        artifactRef: artifact("d"),
        gateId: "release-authority",
        taskId: "b",
      },
      requestId: "gate-b",
      workflowId,
    });
    expect((await port.query({ name: "ready", workflowId })).value).toEqual([
      "b",
    ]);
    expect(await port.inspect(workflowId)).toMatchObject({
      revision: 5,
      status: "running",
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    });
  }, 120_000);
});

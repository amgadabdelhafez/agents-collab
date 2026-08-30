import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import { GovernedSupervisorMessageService } from "../../src/loop/supervisor-message-governance";
import { supervisorMessageWorkflowDefinition } from "../../src/loop/supervisor-message-workflow";
import { createSupervisorOrchestrationHttpHandler } from "../../src/loop/supervisor-orchestration-http";
import { SupervisorOrchestrationRuntime } from "../../src/loop/supervisor-orchestration-runtime";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TaskGraphRuntime } from "../../src/loop/task-graph-runtime";
import {
  TASK_GRAPH_WORKFLOW_TYPE,
  taskGraphWorkflowDefinition,
} from "../../src/loop/task-graph-workflow";

const roots: string[] = [];
const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const graphInput = (dependencies: string[] = []) => ({
  graphId: "http-graph",
  nodes: [
    {
      acceptanceChecks: [{ checkId: "task-a:test", kind: "test" }],
      authorityGates: [],
      dependencies,
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: artifact("a"),
      taskId: "task-a",
      writeScopes: ["loop-fork/src/a"],
    },
  ],
  schema: TASK_GRAPH_WORKFLOW_TYPE,
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "orch-http-"));
  roots.push(root);
  const workflows = new InMemoryWorkflowPort({
    definitions: [
      supervisorMessageWorkflowDefinition,
      taskGraphWorkflowDefinition,
    ],
    now: () => "2026-08-30T10:00:00.000Z",
  });
  const coordinator = new SupervisorMessageCoordinator(workflows, {
    deliver: () => Promise.resolve({ status: "accepted" as const }),
  });
  const governed = new GovernedSupervisorMessageService({
    authority: {
      decide: () => ({
        allowed: true,
        authorityRef: "authority:http-test",
        reasonCode: "allowed",
      }),
    },
    coordinator,
    receipts: { record: () => undefined },
  });
  const messages = new SupervisorOrchestrationRuntime({
    governed,
    store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
  });
  const tasks = new TaskGraphRuntime({ workflows });
  const handler = createSupervisorOrchestrationHttpHandler({
    authenticator: {
      authenticate: (request) =>
        request.headers.get("authorization") === "Bearer valid"
          ? {
              principal: "worker:harness",
              supervisorId: "supervisor:harness",
            }
          : undefined,
    },
    messages,
    tasks,
  });
  return { handler, workflows };
};

const request = (
  path: string,
  body?: Record<string, unknown>,
  authorization = "Bearer valid"
): Request =>
  new Request(`http://localhost${path}`, {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: {
            authorization,
            "content-type": "application/json",
          },
          method: "POST",
        }),
    ...(body === undefined ? { headers: { authorization } } : {}),
  });

describe("authenticated orchestration HTTP surface", () => {
  test("creates, claims, starts, completes, and projects a canonical graph", async () => {
    const { handler } = setup();
    const workflowId = "task-graph:http";
    expect(
      await handler(
        request("/api/v1/task-graphs/start", {
          input: graphInput(),
          requestId: "start-1",
          workflowId,
        })
      )
    ).toMatchObject({ status: 200 });
    const ready = await handler(
      request(`/api/v1/task-graphs/${workflowId}/ready`)
    );
    expect(await ready.json()).toMatchObject({ data: { value: ["task-a"] } });
    for (const [operation, requestId] of [
      ["claim", "claim-1"],
      ["begin", "begin-1"],
    ]) {
      expect(
        await handler(
          request(`/api/v1/task-graphs/${operation}`, {
            requestId,
            taskId: "task-a",
            workflowId,
          })
        )
      ).toMatchObject({ status: 200 });
    }
    const completed = await handler(
      request("/api/v1/task-graphs/complete", {
        receipts: [{ artifactRef: artifact("b"), checkId: "task-a:test" }],
        requestId: "complete-1",
        taskId: "task-a",
        workflowId,
      })
    );
    expect(completed.status).toBe(200);
    const status = await handler(
      request(`/api/v1/task-graphs/${workflowId}/status`)
    );
    expect(await status.json()).toMatchObject({
      data: {
        status: "completed",
        value: {
          nodes: [{ taskId: "task-a", workerId: "worker:harness" }],
        },
      },
    });
  });

  test("refuses unauthenticated, spoofed-worker, and invalid graph requests without creation", async () => {
    const { handler, workflows } = setup();
    expect(
      await handler(request("/api/v1/supervisor-threads", undefined, ""))
    ).toMatchObject({ status: 401 });
    expect(
      await handler(
        request("/api/v1/task-graphs/claim", {
          requestId: "claim-spoof",
          taskId: "task-a",
          workerId: "worker:foreign",
          workflowId: "task-graph:missing",
        })
      )
    ).toMatchObject({ status: 400 });
    const invalid = await handler(
      request("/api/v1/task-graphs/start", {
        input: graphInput(["task-a"]),
        requestId: "invalid-start",
        workflowId: "task-graph:invalid",
      })
    );
    expect(invalid.status).toBe(400);
    expect(() => workflows.inspect("task-graph:invalid")).toThrow("not found");
  });

  test("serves durable board, Attention, and knowledge snapshots with no-store", async () => {
    const { handler } = setup();
    for (const path of [
      "/api/v1/supervisor-threads",
      "/api/v1/supervisor-attention",
      "/api/v1/supervisor-knowledge",
    ]) {
      const response = await handler(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toHaveProperty("data");
    }
  });
});

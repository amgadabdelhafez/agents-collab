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

const setup = (resultGraphRoutePath?: string) => {
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
    ...(resultGraphRoutePath === undefined ? {} : { resultGraphRoutePath }),
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

  test("never starts a graph under a result graph id: only the message-driven route derives one", async () => {
    const { handler, workflows } = setup("/a2a/v2/result-graph");
    for (const workflowId of [
      `supervisor-result-graph:v3:${"c".repeat(64)}`,
      `supervisor-result-graph:v2:${"c".repeat(64)}`,
      "supervisor-result-graph:v9:anything",
    ]) {
      const refused = await handler(
        request("/api/v1/task-graphs/start", {
          input: graphInput(),
          requestId: `squat-${workflowId.length}`,
          workflowId,
        })
      );
      expect(refused.status).toBe(403);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code
      ).toBe("result-graph-id-reserved");
      expect(() => workflows.inspect(workflowId)).toThrow("not found");
    }
  });

  test("a reserved result graph id refusal names the replacement route and the result-graph-id CLI", async () => {
    const { handler, workflows } = setup("/a2a/v2/result-graph");
    const workflowId = `supervisor-result-graph:v3:${"d".repeat(64)}`;
    const refused = await handler(
      request("/api/v1/task-graphs/start", {
        input: graphInput(),
        requestId: "operator-script",
        workflowId,
      })
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    const body = (await refused.json()) as {
      error: { code: string; message: string; replacement: unknown };
    };
    expect(body.error.code).toBe("result-graph-id-reserved");
    expect(body.error.replacement).toEqual({
      body: ["input", "messageWorkflowId", "requestId"],
      method: "POST",
      resultGraphIdCommand:
        "loop orchestration result-graph-id <config-path> <message-workflow-id>",
      route: "/a2a/v2/result-graph",
    });
    expect(body.error.message).toContain("POST /a2a/v2/result-graph");
    expect(body.error.message).toContain(
      "loop orchestration result-graph-id <config-path> <message-workflow-id>"
    );
    expect(() => workflows.inspect(workflowId)).toThrow("not found");
  });

  test("a reserved result graph id refusal on a server without an A2A V2 route still names the CLI and says no route is configured", async () => {
    const { handler } = setup();
    const refused = await handler(
      request("/api/v1/task-graphs/start", {
        input: graphInput(),
        requestId: "operator-script",
        workflowId: `supervisor-result-graph:v3:${"e".repeat(64)}`,
      })
    );
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as {
      error: {
        code: string;
        message: string;
        replacement: { route: unknown; resultGraphIdCommand: string };
      };
    };
    expect(body.error.code).toBe("result-graph-id-reserved");
    expect(body.error.replacement.route).toBeNull();
    expect(body.error.replacement.resultGraphIdCommand).toBe(
      "loop orchestration result-graph-id <config-path> <message-workflow-id>"
    );
    expect(body.error.message).toContain("<routePath>/result-graph");
    expect(body.error.message).toContain("no A2A V2 route");
  });

  test("graph ids outside the reserved prefix start exactly as before", async () => {
    const reserved = setup("/a2a/v2/result-graph");
    const plain = setup();
    for (const workflowId of [
      "task-graph:operator",
      "supervisor-result-graph",
      "supervisor-result-graphs:v3:x",
      "Supervisor-Result-Graph:v3:x",
      "x-supervisor-result-graph:v3:x",
      "task-graph:supervisor-result-graph:v3:x",
    ]) {
      const command = {
        input: graphInput(),
        requestId: `start-${workflowId.length}`,
        workflowId,
      };
      const routed = await reserved.handler(
        request("/api/v1/task-graphs/start", command)
      );
      const unrouted = await plain.handler(
        request("/api/v1/task-graphs/start", command)
      );
      expect(routed.status).toBe(200);
      expect(unrouted.status).toBe(200);
      // The configured route changes nothing for these ids.
      expect(await routed.json()).toEqual(await unrouted.json());
      expect(reserved.workflows.inspect(workflowId)).toBeDefined();
    }
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

/** A body that counts what the handler actually pulled from the client. */
const meteredBody = (totalBytes: number) => {
  const meter = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (meter.pulled >= totalBytes) {
          controller.close();
          return;
        }
        meter.pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        meter.cancelled = true;
      },
    },
    // No read-ahead: every pulled chunk was requested by the handler.
    { highWaterMark: 0 }
  );
  return { meter, stream };
};

const streamedPost = (
  body: BodyInit,
  headers: Record<string, string> = {},
  authorization = "Bearer valid"
): Request =>
  new Request("http://localhost/api/v1/task-graphs/start", {
    body,
    duplex: "half",
    headers: {
      authorization,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  } as RequestInit);

describe("orchestration HTTP body bounds", () => {
  const MiB = 1024 * 1024;
  const MAX_BODY_BYTES = 64 * 1024;

  test("authenticates before refusing a declared oversized body unread", async () => {
    const { handler } = setup();
    const unauthenticated = meteredBody(MiB);
    expect(
      (
        await handler(
          streamedPost(
            unauthenticated.stream,
            { "content-length": String(MiB) },
            "Bearer wrong"
          )
        )
      ).status
    ).toBe(401);
    expect(unauthenticated.meter.pulled).toBe(0);
    const declared = meteredBody(MiB);
    const response = await handler(
      streamedPost(declared.stream, { "content-length": String(MiB) })
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "body-too-large" },
    });
    expect(declared.meter.pulled).toBe(0);
  });

  test("stops reading an undeclared oversized body at the cap", async () => {
    const { handler, workflows } = setup();
    const streamed = meteredBody(MiB);
    const response = await handler(streamedPost(streamed.stream));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "body-too-large" },
    });
    // Bounded by the 64 KiB cap plus the one chunk that crossed it.
    expect(streamed.meter.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 1024);
    expect(streamed.meter.cancelled).toBe(true);
    expect(() => workflows.inspect("task-graph:http")).toThrow("not found");
  });

  test("still accepts an in-limit body and refuses one byte over", async () => {
    const { handler } = setup();
    const body = JSON.stringify({
      input: graphInput(),
      requestId: "start-bounded",
      workflowId: "task-graph:bounded",
    });
    const padded = `${body}${" ".repeat(MAX_BODY_BYTES - body.length)}`;
    expect((await handler(streamedPost(padded))).status).toBe(200);
    expect((await handler(streamedPost(`${padded} `))).status).toBe(413);
  });
});

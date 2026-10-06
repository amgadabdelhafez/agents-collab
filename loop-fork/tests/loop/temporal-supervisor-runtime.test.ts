import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TemporalSupervisorRuntimeHost } from "../../src/loop/temporal-supervisor-runtime";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import type { WorkflowPort } from "../../src/loop/workflow-port";

test("Temporal host rejects an unknown workflow execution mode before startup", async () => {
  await expect(
    TemporalSupervisorRuntimeHost.create({
      authority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:temporal-test",
          reasonCode: "allowed",
        }),
      },
      buildId: "supervisor-runtime.v1",
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" }),
      },
      identity: "supervisor-runtime@test",
      namespace: "default",
      nativeConnection: {},
      receipts: { record: () => undefined },
      store: {} as JsonlSupervisorThreadStore,
      taskQueue: "supervisor-runtime-invalid",
      workflowBundle: { code: "invalid-but-unread" },
      workflowClient: {},
      workflowExecution: "unknown" as "threaded",
    })
  ).rejects.toThrow("workflowExecution is invalid");
});

test("real Temporal host completes governed delivery and closes once", async () => {
  const root = mkdtempSync(join(tmpdir(), "temporal-supervisor-runtime-"));
  const environment = await TestWorkflowEnvironment.createLocal();
  let host: TemporalSupervisorRuntimeHost | undefined;
  try {
    host = await TemporalSupervisorRuntimeHost.create({
      authority: {
        decide: () => ({
          allowed: true,
          authorityRef: "authority:temporal-test",
          reasonCode: "allowed",
        }),
      },
      buildId: "supervisor-runtime.v1",
      delivery: {
        deliver: () => Promise.resolve({ status: "accepted" }),
      },
      identity: "supervisor-runtime@test",
      namespace: environment.client.workflow.options.namespace,
      nativeConnection: environment.nativeConnection,
      receipts: { record: () => undefined },
      store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
      taskQueue: `supervisor-runtime-${process.pid}`,
      workflowClient: environment.client.workflow,
      workflowExecution: "in-process",
      workflowsPath: new URL(
        "../../src/loop/temporal-workflow.ts",
        import.meta.url
      ).pathname,
    });
    expect(host.workerState()).toBe("RUNNING");
    const received = await host.runtime.receive({
      input: {
        artifactRefs: [],
        body: "Temporal runtime integration proof",
        dedupeKey: "temporal-runtime-message-1",
        from: "supervisor:harvto",
        messageId: "temporal-runtime-message-1",
        policy: {
          claimTimeoutMs: 60_000,
          escalationTimeoutMs: 120_000,
          maxDeliveryAttempts: 3,
          retryDelayMs: 1000,
        },
        receivedAt: "2026-08-30T07:00:00.000Z",
        threadId: "temporal-runtime-thread-1",
        to: "supervisor:harness",
      },
      messageKind: "question",
      principal: "principal:harvto",
      requestId: "temporal-receive-1",
    });
    await host.runtime.claim({
      claimant: "supervisor:harness",
      principal: "principal:harness",
      requestId: "temporal-claim-1",
      workflowId: received.workflowId,
    });
    await host.runtime.acknowledge({
      claimant: "supervisor:harness",
      principal: "principal:harness",
      requestId: "temporal-ack-1",
      workflowId: received.workflowId,
    });
    expect(host.runtime.threads()).toMatchObject({
      revision: 3,
      threads: [
        {
          messages: [{ item: { phase: "acknowledged" } }],
        },
      ],
    });
    expect(host.runtime.attention().items).toHaveLength(1);
  } finally {
    if (host) {
      await host.close();
      await host.close();
      expect(host.workerState()).toBe("STOPPED");
    }
    await environment.teardown();
    rmSync(root, { force: true, recursive: true });
  }
}, 60_000);

const compositionOptions = (
  overrides: Partial<Parameters<typeof TemporalSupervisorRuntimeHost.create>[0]>
): Parameters<typeof TemporalSupervisorRuntimeHost.create>[0] => ({
  authority: {
    decide: () => ({
      allowed: true,
      authorityRef: "authority:temporal-test",
      reasonCode: "allowed",
    }),
  },
  buildId: "supervisor-runtime.v1",
  delivery: {
    deliver: () => Promise.resolve({ status: "accepted" }),
  },
  identity: "supervisor-runtime@test",
  namespace: "deployment-a",
  // Never reached: composition is refused before the worker is created.
  nativeConnection: {},
  receipts: { record: () => undefined },
  store: {} as JsonlSupervisorThreadStore,
  taskQueue: "supervisor-runtime-a",
  workflowBundle: { code: "invalid-but-unread" },
  workflowClient: { options: { namespace: "deployment-a" } },
  ...overrides,
});

const unused = () => {
  throw new Error("unused");
};

const unusedPort = (taskQueue?: string): WorkflowPort => ({
  cancel: unused,
  inspect: unused,
  query: unused,
  signal: unused,
  start: unused,
  ...(taskQueue === undefined ? {} : { taskQueue }),
});

describe("Temporal host composition binds one deployment", () => {
  test("refuses a workflow port that starts executions on another task queue", async () => {
    await expect(
      TemporalSupervisorRuntimeHost.create(
        compositionOptions({ workflowPort: unusedPort("supervisor-runtime-b") })
      )
    ).rejects.toThrow(
      "Temporal supervisor workflowPort task queue does not match its worker"
    );
  });

  test("refuses a workflow port that declares no task queue", async () => {
    await expect(
      TemporalSupervisorRuntimeHost.create(
        compositionOptions({ workflowPort: unusedPort() })
      )
    ).rejects.toThrow(
      "Temporal supervisor workflowPort task queue does not match its worker"
    );
  });

  test("refuses a workflow client bound to another namespace", async () => {
    await expect(
      TemporalSupervisorRuntimeHost.create(
        compositionOptions({
          workflowClient: { options: { namespace: "deployment-b" } },
        })
      )
    ).rejects.toThrow(
      "Temporal supervisor workflowClient namespace does not match its worker"
    );
  });

  test("refuses an absent namespace instead of reading it as the text undefined", async () => {
    await expect(
      TemporalSupervisorRuntimeHost.create(
        compositionOptions({
          namespace: undefined as unknown as string,
          workflowClient: { options: { namespace: "undefined" } },
        })
      )
    ).rejects.toThrow("Temporal supervisor namespace is invalid");
  });

  test("refuses a workflow client that does not declare its namespace", async () => {
    await expect(
      TemporalSupervisorRuntimeHost.create(
        compositionOptions({ workflowClient: {} })
      )
    ).rejects.toThrow(
      "Temporal supervisor workflowClient namespace does not match its worker"
    );
  });

  test("the Temporal port declares the task queue it starts executions on", () => {
    expect(
      new TemporalWorkflowPort({}, { taskQueue: "supervisor-runtime-a" })
        .taskQueue
    ).toBe("supervisor-runtime-a");
    expect(() => new TemporalWorkflowPort({}, { taskQueue: "" })).toThrow(
      "Temporal workflow port taskQueue is invalid"
    );
  });
});

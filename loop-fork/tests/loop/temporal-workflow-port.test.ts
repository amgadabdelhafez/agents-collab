import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST,
  supervisorMessageReplayFixtures,
} from "../../src/loop/supervisor-message-replay-fixtures";
import { TASK_GRAPH_WORKFLOW_TYPE } from "../../src/loop/task-graph-workflow";
import { TemporalSupervisorMessageReplayRuntime } from "../../src/loop/temporal-replay-runtime";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import type { JsonObject } from "../../src/loop/workflow-port";
import { runSupervisorMessageReplayCorpus } from "../../src/loop/workflow-replay-corpus";

const runFreshTemporalCorpus = async (suffix: string) => {
  const runtime = await TemporalSupervisorMessageReplayRuntime.create(
    `orch-temporal-replay-${process.pid}-${suffix}`
  );
  try {
    const result = await runSupervisorMessageReplayCorpus(
      supervisorMessageReplayFixtures,
      () => runtime
    );
    return { identity: runtime.workerIdentity(), result };
  } finally {
    await runtime.close();
  }
};

describe("Temporal WorkflowPort conformance", () => {
  test("runs the unchanged frozen corpus twice on fresh Temporal servers", async () => {
    const first = await runFreshTemporalCorpus("first");
    const second = await runFreshTemporalCorpus("second");
    expect(first.result).toEqual(second.result);
    expect(first.result.aggregateDigest).toBe(
      SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST
    );
    expect(first.result.cases).toHaveLength(
      supervisorMessageReplayFixtures.length
    );
    expect(first.identity).toMatchObject({
      version: "supervisor-message.v2-worker",
    });
    expect(first.identity.generation).toBeGreaterThan(1);
  }, 180_000);

  test("keeps Temporal types out of canonical workflow and fixture modules", async () => {
    const canonicalPaths = [
      "src/loop/workflow-port.ts",
      "src/loop/in-memory-workflow-port.ts",
      "src/loop/supervisor-message-workflow.ts",
      "src/loop/supervisor-message-coordinator.ts",
      "src/loop/workflow-replay-corpus.ts",
      "src/loop/supervisor-message-replay-fixtures.ts",
    ];
    for (const path of canonicalPaths) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@temporalio/");
      expect(source).not.toContain("@dbos-inc/");
    }
  });

  test("pins one exact Temporal SDK version across direct dependencies", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toMatchObject({
      "@temporalio/client": "1.23.0",
      "@temporalio/testing": "1.23.0",
      "@temporalio/worker": "1.23.0",
      "@temporalio/workflow": "1.23.0",
    });
  });
});

const singleNodeGraph: JsonObject = {
  graphId: "temporal-port-ownership",
  nodes: [
    {
      acceptanceChecks: [{ checkId: "only:test", kind: "test" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: `artifact://sha256/${"e".repeat(64)}`,
      taskId: "only",
      writeScopes: ["loop-fork/src/only"],
    },
  ],
  schema: TASK_GRAPH_WORKFLOW_TYPE,
};

describe("Temporal WorkflowPort execution ownership", () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let owner: TemporalWorkflowPort;
  let foreign: TemporalWorkflowPort;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `port-owner-${process.pid}`;
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
    owner = new TemporalWorkflowPort(environment.client.workflow, {
      now: () => "2026-10-05T00:00:00.000Z",
      taskQueue,
    });
    // A second deployment sharing the namespace under its own task queue.
    foreign = new TemporalWorkflowPort(environment.client.workflow, {
      now: () => "2026-10-05T00:00:00.000Z",
      taskQueue: `port-foreign-${process.pid}`,
    });
  });

  afterAll(async () => {
    if (worker.getState() === "RUNNING") {
      worker.shutdown();
    }
    await workerRun;
    await environment.teardown();
  });

  test("reports an execution Temporal does not know as missing, not closed", async () => {
    const workflowId = `port-missing-${process.pid}`;
    await expect(owner.presence(workflowId)).resolves.toBe("missing");
    await expect(owner.isClosed(workflowId)).resolves.toBe(false);
  });

  test("refuses to adopt a same-ID execution owned by another task queue", async () => {
    const workflowId = `port-ownership-${process.pid}`;
    const command = {
      input: singleNodeGraph,
      requestId: "start-owner",
      workflowId,
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    };
    await expect(owner.start(command)).resolves.toMatchObject({
      created: true,
    });
    await expect(owner.start(command)).resolves.toMatchObject({
      created: false,
      replayed: true,
    });
    await expect(
      foreign.start({ ...command, requestId: "start-foreign" })
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    await expect(owner.presence(workflowId)).resolves.toBe("running");
  }, 60_000);

  test("refuses a closed same-ID execution owned by another task queue", async () => {
    const workflowId = `port-ownership-closed-${process.pid}`;
    const command = {
      input: singleNodeGraph,
      requestId: "start-owner-closed",
      workflowId,
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    };
    await expect(owner.start(command)).resolves.toMatchObject({
      created: true,
    });
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate("retention proof");
    await expect(owner.presence(workflowId)).resolves.toBe("closed");
    await expect(
      foreign.start({ ...command, requestId: "start-foreign-closed" })
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
  }, 60_000);

  test("reports a same-ID execution owned by another task queue as a conflict, never as its own", async () => {
    const workflowId = `port-presence-foreign-${process.pid}`;
    await expect(
      owner.start({
        input: singleNodeGraph,
        requestId: "start-owner-presence",
        workflowId,
        workflowType: TASK_GRAPH_WORKFLOW_TYPE,
      })
    ).resolves.toMatchObject({ created: true });
    // Running: another deployment must not read the execution as running.
    await expect(foreign.presence(workflowId)).rejects.toMatchObject({
      code: "conflict",
      name: "WorkflowError",
    });
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate("retention proof");
    // Closed: reading it as closed would let a recovery sweep record the
    // owner's outcome as its own.
    await expect(owner.presence(workflowId)).resolves.toBe("closed");
    await expect(foreign.presence(workflowId)).rejects.toMatchObject({
      code: "conflict",
      name: "WorkflowError",
    });
    await expect(foreign.isClosed(workflowId)).rejects.toMatchObject({
      code: "conflict",
      name: "WorkflowError",
    });
  }, 60_000);

  /**
   * Every method that addresses an existing execution goes through the one
   * owned-handle check. Each test starts the owner's execution, has the other
   * deployment address it by the same ID, and proves the call is refused and
   * the owner's execution is unchanged. Values are settled first: a failing
   * `expect(promise).rejects` stalls under this runner with Temporal open.
   */
  const settle = async (promise: Promise<unknown>) => {
    try {
      return { value: await promise };
    } catch (error) {
      return {
        error: {
          code: (error as { code?: unknown }).code,
          name: (error as Error).name,
        },
      };
    }
  };
  const REFUSED = { error: { code: "conflict", name: "WorkflowError" } };
  const startOwned = async (suffix: string): Promise<string> => {
    const workflowId = `port-owned-${suffix}-${process.pid}`;
    await owner.start({
      input: singleNodeGraph,
      requestId: `start-${suffix}`,
      workflowId,
      workflowType: TASK_GRAPH_WORKFLOW_TYPE,
    });
    return workflowId;
  };
  const revisionOf = async (workflowId: string) =>
    (await owner.inspect(workflowId)).revision;

  test("refuses to inspect a same-ID execution owned by another task queue", async () => {
    const workflowId = await startOwned("inspect");
    expect(await settle(foreign.inspect(workflowId))).toEqual(REFUSED);
    expect((await owner.inspect(workflowId)).workflowId).toBe(workflowId);
  }, 60_000);

  test("refuses to query a same-ID execution owned by another task queue", async () => {
    const workflowId = await startOwned("query");
    expect(await settle(foreign.query({ name: "status", workflowId }))).toEqual(
      REFUSED
    );
    expect(await settle(foreign.query({ name: "ready", workflowId }))).toEqual(
      REFUSED
    );
    expect((await owner.query({ name: "ready", workflowId })).value).toEqual([
      "only",
    ]);
  }, 60_000);

  test("refuses to signal a same-ID execution owned by another task queue and leaves it unchanged", async () => {
    const workflowId = await startOwned("signal");
    const before = await revisionOf(workflowId);
    expect(
      await settle(
        foreign.signal({
          name: "claim",
          payload: { taskId: "only", workerId: "foreign-worker" },
          requestId: "foreign-claim",
          workflowId,
        })
      )
    ).toEqual(REFUSED);
    expect(await revisionOf(workflowId)).toBe(before);
    // The owner can still make the very claim the foreign port was refused.
    expect(
      await settle(
        owner.signal({
          name: "claim",
          payload: { taskId: "only", workerId: "owner-worker" },
          requestId: "owner-claim",
          workflowId,
        })
      )
    ).toMatchObject({ value: { status: "running" } });
  }, 60_000);

  test("refuses to cancel a same-ID execution owned by another task queue and leaves it running", async () => {
    const workflowId = await startOwned("cancel");
    const before = await revisionOf(workflowId);
    expect(
      await settle(
        foreign.cancel({
          reason: "foreign cancel",
          requestId: "foreign-cancel",
          workflowId,
        })
      )
    ).toEqual(REFUSED);
    expect(await revisionOf(workflowId)).toBe(before);
    expect((await owner.inspect(workflowId)).status).toBe("running");
  }, 60_000);
});

describe("Temporal WorkflowPort owned handle", () => {
  /**
   * A fake client: `describe` reports the execution by ID, and every handle
   * the port asks for is recorded with the run it pins. The port must use the
   * exact run it verified, so an ID whose run changes between the ownership
   * check and the call can never redirect a query or signal to a foreign run.
   */
  const fakeClient = (taskQueue: string) => {
    const handles: { runId: string | undefined; workflowId: string }[] = [];
    const client = {
      getHandle(workflowId: string, runId?: string) {
        handles.push({ runId, workflowId });
        return {
          describe: () =>
            Promise.resolve({
              runId: "verified-run",
              status: { name: "RUNNING" },
              taskQueue,
            }),
          query: () =>
            Promise.resolve({
              createdAt: "2026-10-05T00:00:00.000Z",
              history: [],
              revision: 1,
              status: "running",
              updatedAt: "2026-10-05T00:00:00.000Z",
              workflowId,
              workflowType: "fake",
            }),
        };
      },
    };
    return { client, handles };
  };

  test("addresses the exact run whose task queue it verified", async () => {
    const { client, handles } = fakeClient("owned-queue");
    const port = new TemporalWorkflowPort(client, { taskQueue: "owned-queue" });
    await port.inspect("owned-id");
    expect(handles.at(-1)).toEqual({
      runId: "verified-run",
      workflowId: "owned-id",
    });
  });
});

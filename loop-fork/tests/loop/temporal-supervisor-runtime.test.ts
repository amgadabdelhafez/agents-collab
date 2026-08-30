import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TemporalSupervisorRuntimeHost } from "../../src/loop/temporal-supervisor-runtime";

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
      namespace: environment.namespace,
      nativeConnection: environment.nativeConnection,
      receipts: { record: () => undefined },
      store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
      taskQueue: `supervisor-runtime-${process.pid}`,
      workflowClient: environment.client.workflow,
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

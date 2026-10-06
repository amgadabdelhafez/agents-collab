import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  consumeBridgeInbox,
  dispatchBridgeMessage,
} from "../../src/loop/bridge-dispatch";
import { readPendingBridgeMessages } from "../../src/loop/bridge-store";
import { BridgeSupervisorMessageDeliveryPort } from "../../src/loop/bridge-supervisor-message-delivery";
import { SupervisorBridgeConsumptionReconciler } from "../../src/loop/supervisor-bridge-consumption";
import type { SupervisorMessageDeliveryRequest } from "../../src/loop/supervisor-message-workflow";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";
import { TemporalSupervisorRuntimeHost } from "../../src/loop/temporal-supervisor-runtime";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

const identityHeaders = (supervisor: "harness" | "harvto") => ({
  "x-principal": `principal:${supervisor}`,
  "x-supervisor-id": `supervisor:${supervisor}`,
});

const parseData = async <T>(response: Response): Promise<T> => {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: T };
  return body.data;
};

test("real Temporal control surface completes cross-supervisor delivery and a dependent DAG without manual relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "temporal-orchestration-e2e-"));
  const environment = await TestWorkflowEnvironment.createLocal();
  const deliveries: SupervisorMessageDeliveryRequest[] = [];
  const governanceReceipts: unknown[] = [];
  const harnessRunDir = join(root, "harness-run");
  let host: TemporalSupervisorRuntimeHost | undefined;
  try {
    const directory = {
      resolve: (supervisorId: string) =>
        supervisorId === "supervisor:harness"
          ? { runDir: harnessRunDir, target: "codex" as const }
          : undefined,
    };
    host = await TemporalSupervisorRuntimeHost.create({
      authority: {
        decide: (request) => ({
          allowed:
            (request.operation === "receive" &&
              request.principal === "principal:harvto" &&
              request.from === "supervisor:harvto" &&
              request.to === "supervisor:harness") ||
            (request.principal === "principal:harness" &&
              request.claimant === "supervisor:harness"),
          authorityRef: "authority:staged-cross-supervisor-proof",
          reasonCode: "staged-proof-policy",
        }),
      },
      buildId: "orchestration-e2e.v1",
      delivery: new BridgeSupervisorMessageDeliveryPort({
        directory,
        dispatch: async (route, request, now) => {
          deliveries.push(structuredClone(request));
          const result = await dispatchBridgeMessage(
            route.runDir,
            "supervisor",
            route.target,
            request.body,
            undefined,
            undefined,
            {
              artifactRefs: request.artifactRefs,
              dedupeKey: request.idempotencyKey,
              now,
              subject: request.messageId,
              taskId: request.workflowId,
              threadId: request.threadId,
              type: "work_request",
            }
          );
          return { ...result, status: "accepted" };
        },
        now: () => "2026-08-30T09:00:00.000Z",
      }),
      identity: "orchestration-e2e@test",
      namespace: environment.client.workflow.options.namespace,
      nativeConnection: environment.nativeConnection,
      receipts: {
        record: (receipt) => {
          governanceReceipts.push(structuredClone(receipt));
        },
      },
      store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
      taskQueue: `orchestration-e2e-${process.pid}`,
      workflowClient: environment.client.workflow,
      workflowBundle: {
        code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
          "utf8"
        ),
      },
    });
    const handler = host.httpHandler({
      authenticate: (request) => {
        const principal = request.headers.get("x-principal");
        const supervisorId = request.headers.get("x-supervisor-id");
        return principal && supervisorId
          ? { principal, supervisorId }
          : undefined;
      },
    });
    const post = (
      path: string,
      body: unknown,
      supervisor: "harness" | "harvto"
    ) =>
      handler(
        new Request(`http://127.0.0.1${path}`, {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            ...identityHeaders(supervisor),
          },
          method: "POST",
        })
      );
    const get = (path: string) =>
      handler(
        new Request(`http://127.0.0.1${path}`, {
          headers: identityHeaders("harness"),
        })
      );

    const received = await parseData<{ workflowId: string }>(
      await post(
        "/api/v1/supervisor-messages/receive",
        {
          input: {
            artifactRefs: [artifact("a")],
            body: "Harvto requests a governed Harness decision",
            dedupeKey: "staged-message-1",
            from: "supervisor:harvto",
            messageId: "staged-message-1",
            policy: {
              claimTimeoutMs: 60_000,
              escalationTimeoutMs: 120_000,
              maxDeliveryAttempts: 3,
              retryDelayMs: 1000,
            },
            receivedAt: "2026-08-30T09:00:00.000Z",
            threadId: "staged-thread-1",
            to: "supervisor:harness",
          },
          messageKind: "question",
          requestId: "staged-receive-1",
        },
        "harvto"
      )
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      idempotencyKey: `${received.workflowId}:delivery:1`,
      target: "supervisor:harness",
      workflowId: received.workflowId,
    });
    expect(readPendingBridgeMessages(harnessRunDir)).toEqual([
      expect.objectContaining({
        source: "supervisor",
        target: "codex",
        taskId: received.workflowId,
      }),
    ]);
    consumeBridgeInbox(harnessRunDir, "codex", "read via receive_messages");
    const reconciler = new SupervisorBridgeConsumptionReconciler({
      bindings: [
        { principal: "principal:harness", supervisorId: "supervisor:harness" },
      ],
      directory,
      runtime: host.runtime,
    });
    expect(await reconciler.reconcile()).toEqual({
      acknowledged: 1,
      claimed: 1,
      inspected: 1,
    });
    const threads = await parseData<{
      revision: number;
      threads: Array<{ messages: Array<{ item: { phase: string } }> }>;
    }>(await get("/api/v1/supervisor-threads"));
    expect(threads).toMatchObject({
      revision: 3,
      threads: [{ messages: [{ item: { phase: "acknowledged" } }] }],
    });
    const attention = await parseData<{ items: unknown[] }>(
      await get("/api/v1/supervisor-attention")
    );
    expect(attention.items).toHaveLength(1);
    const knowledge = await parseData<{
      artifacts: Array<{ artifactRef: string; referenceCount: number }>;
    }>(await get("/api/v1/supervisor-knowledge"));
    expect(knowledge.artifacts).toEqual([
      {
        artifactRef: artifact("a"),
        backlinks: expect.any(Array),
        referenceCount: 1,
        schema: "supervisor-knowledge-artifact.v2",
      },
    ]);
    expect(governanceReceipts).toHaveLength(3);

    const graphId = "task-graph:staged-proof";
    const node = (
      taskId: string,
      dependencies: string[],
      specDigit: string
    ) => ({
      acceptanceChecks: [{ checkId: `${taskId}:test`, kind: "test" }],
      authorityGates: [],
      dependencies,
      ownerRepository: "agents-collab",
      readScopes: ["loop-fork/src"],
      specArtifactRef: artifact(specDigit),
      taskId,
      writeScopes: [`loop-fork/src/${taskId}`],
    });
    await parseData(
      await post(
        "/api/v1/task-graphs/start",
        {
          input: {
            graphId: "staged-proof",
            nodes: [
              node("consumer", ["foundation"], "c"),
              node("foundation", [], "b"),
            ],
            schema: "task-graph.v1",
          },
          requestId: "graph-start-1",
          workflowId: graphId,
        },
        "harness"
      )
    );
    const readyBefore = await parseData<{ value: string[] }>(
      await get(`/api/v1/task-graphs/${graphId}/ready`)
    );
    expect(readyBefore.value).toEqual(["foundation"]);
    for (const operation of ["claim", "begin"] as const) {
      await parseData(
        await post(
          `/api/v1/task-graphs/${operation}`,
          {
            requestId: `foundation-${operation}`,
            taskId: "foundation",
            workflowId: graphId,
          },
          "harness"
        )
      );
    }
    await parseData(
      await post(
        "/api/v1/task-graphs/complete",
        {
          receipts: [
            { artifactRef: artifact("d"), checkId: "foundation:test" },
          ],
          requestId: "foundation-complete",
          taskId: "foundation",
          workflowId: graphId,
        },
        "harness"
      )
    );
    const readyAfter = await parseData<{ value: string[] }>(
      await get(`/api/v1/task-graphs/${graphId}/ready`)
    );
    expect(readyAfter.value).toEqual(["consumer"]);
    for (const operation of ["claim", "begin"] as const) {
      await parseData(
        await post(
          `/api/v1/task-graphs/${operation}`,
          {
            requestId: `consumer-${operation}`,
            taskId: "consumer",
            workflowId: graphId,
          },
          "harness"
        )
      );
    }
    await parseData(
      await post(
        "/api/v1/task-graphs/complete",
        {
          receipts: [{ artifactRef: artifact("e"), checkId: "consumer:test" }],
          requestId: "consumer-complete",
          taskId: "consumer",
          workflowId: graphId,
        },
        "harness"
      )
    );
    const finalStatus = await parseData<{
      status: string;
      value: { readyTaskIds: string[] };
    }>(await get(`/api/v1/task-graphs/${graphId}/status`));
    expect(finalStatus).toMatchObject({
      status: "completed",
      value: { readyTaskIds: [] },
    });
  } finally {
    if (host) {
      await host.close();
    }
    await environment.teardown();
    rmSync(root, { force: true, recursive: true });
  }
}, 60_000);

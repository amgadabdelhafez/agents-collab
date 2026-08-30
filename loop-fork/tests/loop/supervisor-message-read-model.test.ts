import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingBridgeMessages } from "../../src/loop/bridge-store";
import { BridgeSupervisorMessageDeliveryPort } from "../../src/loop/bridge-supervisor-message-delivery";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  JsonlSupervisorMessageReceiptPort,
  type SupervisorMessageAuthorityRequest,
} from "../../src/loop/supervisor-message-governance";
import {
  SupervisorMessageReadModel,
  SupervisorMessageReadModelError,
} from "../../src/loop/supervisor-message-read-model";
import {
  type SupervisorMessageInput,
  type SupervisorMessageProjection,
  supervisorMessageWorkflowDefinition,
} from "../../src/loop/supervisor-message-workflow";

const AT = "2026-08-30T06:40:00.000Z";
const ARTIFACT_REF = `artifact://sha256/${"d".repeat(64)}`;
const FIRST_WORKFLOW = `supervisor-message:${"1".repeat(64)}`;
const SECOND_WORKFLOW = `supervisor-message:${"2".repeat(64)}`;
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const projection = (
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageProjection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [ARTIFACT_REF],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: AT,
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:harvto",
  messageId: "message-cross-supervisor-1",
  nextRetryAt: null,
  phase: "routed",
  receivedAt: AT,
  schema: "supervisor-message-status.v1",
  threadId: "thread-cross-supervisor-1",
  to: "supervisor:harness",
  ...overrides,
});

describe("SupervisorMessage board and Attention read model", () => {
  test("strictly ingests, deduplicates, orders, and returns defensive snapshots", () => {
    const model = new SupervisorMessageReadModel();
    model.upsert(
      FIRST_WORKFLOW,
      projection({ receivedAt: "2026-08-30T06:39:00.000Z" })
    );
    model.upsert(SECOND_WORKFLOW, projection({ messageId: "message-2" }));
    const duplicate = model.upsert(
      SECOND_WORKFLOW,
      projection({ messageId: "message-2" })
    );

    expect(duplicate.board.revision).toBe(2);
    expect(duplicate.board.items.map((item) => item.workflowId)).toEqual([
      SECOND_WORKFLOW,
      FIRST_WORKFLOW,
    ]);
    duplicate.board.items[0]?.artifactRefs.push(
      `artifact://sha256/${"e".repeat(64)}`
    );
    expect(model.board().items[0]?.artifactRefs).toEqual([ARTIFACT_REF]);
  });

  test("refuses noncanonical, conflicting, and body-bearing projections", () => {
    const model = new SupervisorMessageReadModel();
    expect(() =>
      model.upsert(FIRST_WORKFLOW, {
        ...projection(),
        body: "must never enter a read model",
      })
    ).toThrow(SupervisorMessageReadModelError);
    expect(() =>
      model.upsert(
        FIRST_WORKFLOW,
        projection({ actionRequired: "none", phase: "routed" })
      )
    ).toThrow("actionRequired conflicts with phase");
    expect(() =>
      model.upsert(
        FIRST_WORKFLOW,
        projection({ artifactRefs: ["/Users/amgad/private.txt"] })
      )
    ).toThrow("artifactRefs are invalid");
    expect(model.snapshot()).toEqual({
      attention: {
        items: [],
        revision: 0,
        schema: "supervisor-message-attention.v1",
      },
      board: {
        items: [],
        revision: 0,
        schema: "supervisor-message-board.v1",
      },
    });
  });

  test("derives Attention membership only from canonical actionRequired", () => {
    const model = new SupervisorMessageReadModel();
    model.upsert(FIRST_WORKFLOW, projection());
    expect(model.attention().items).toHaveLength(1);
    model.upsert(
      FIRST_WORKFLOW,
      projection({
        acknowledgedAt: "2026-08-30T06:42:00.000Z",
        actionRequired: "none",
        claimedAt: "2026-08-30T06:41:00.000Z",
        claimedBy: "supervisor:harness",
        phase: "acknowledged",
      })
    );
    expect(model.board().items).toHaveLength(1);
    expect(model.attention().items).toEqual([]);
    expect(model.remove(FIRST_WORKFLOW).board.items).toEqual([]);
  });

  test("proves governed cross-supervisor delivery, claim, and acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "comm-attention-proof-"));
    tempRoots.push(root);
    const harnessRunDir = join(root, "harness-run");
    const authorityCalls: SupervisorMessageAuthorityRequest[] = [];
    const workflows = new InMemoryWorkflowPort({
      definitions: [supervisorMessageWorkflowDefinition],
      now: () => AT,
    });
    const delivery = new BridgeSupervisorMessageDeliveryPort({
      directory: {
        resolve: (supervisorId) =>
          supervisorId === "supervisor:harness"
            ? { runDir: harnessRunDir, target: "supervisor" }
            : undefined,
      },
      now: () => AT,
    });
    const service = new GovernedSupervisorMessageService({
      authority: {
        decide: (request) => {
          authorityCalls.push(structuredClone(request));
          return {
            allowed: true,
            authorityRef: "grant:cross-supervisor-proof",
            reasonCode: "scope-allowed",
          };
        },
      },
      coordinator: new SupervisorMessageCoordinator(workflows, delivery),
      now: () => AT,
      receipts: new JsonlSupervisorMessageReceiptPort(
        join(root, "governance", "receipts.jsonl")
      ),
    });
    const input: SupervisorMessageInput = {
      artifactRefs: [ARTIFACT_REF],
      body: "Harness action requested directly by Harvto supervisor",
      dedupeKey: "harvto-to-harness-live-proof-1",
      from: "supervisor:harvto",
      messageId: "message-cross-supervisor-live-1",
      policy: {
        claimTimeoutMs: 1000,
        escalationTimeoutMs: 2000,
        maxDeliveryAttempts: 2,
        retryDelayMs: 500,
      },
      receivedAt: AT,
      threadId: "thread-cross-supervisor-live-1",
      to: "supervisor:harness",
    };
    const model = new SupervisorMessageReadModel();
    const received = await service.receive(
      "workload:harvto-supervisor",
      input,
      "receive-live-proof-1"
    );
    model.upsert(received.workflowId, received.projection);

    const pending = readPendingBridgeMessages(harnessRunDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      dedupeKey: `${received.workflowId}:delivery:1`,
      source: "supervisor",
      target: "supervisor",
      threadId: input.threadId,
    });
    expect(model.attention().items[0]).toMatchObject({
      actionRequired: "claim",
      from: "supervisor:harvto",
      to: "supervisor:harness",
    });

    const claimed = await service.claim({
      claimant: "supervisor:harness",
      principal: "workload:harness-supervisor",
      requestId: "claim-live-proof-1",
      workflowId: received.workflowId,
    });
    model.upsert(received.workflowId, claimed);
    expect(model.attention().items[0]?.actionRequired).toBe("acknowledge");

    const acknowledged = await service.acknowledge({
      claimant: "supervisor:harness",
      principal: "workload:harness-supervisor",
      requestId: "ack-live-proof-1",
      workflowId: received.workflowId,
    });
    const finalSnapshot = model.upsert(received.workflowId, acknowledged);
    expect(finalSnapshot.board.items[0]).toMatchObject({
      actionRequired: "none",
      phase: "acknowledged",
    });
    expect(finalSnapshot.attention.items).toEqual([]);
    expect(authorityCalls.map((call) => call.operation)).toEqual([
      "receive",
      "claim",
      "acknowledge",
    ]);
    expect(JSON.stringify(finalSnapshot)).not.toContain("body");
    expect(JSON.stringify(finalSnapshot)).not.toContain("/Users/");
    expect(JSON.stringify(authorityCalls)).not.toContain("founder");
    expect((await workflows.inspect(received.workflowId)).revision).toBe(4);
  });
});

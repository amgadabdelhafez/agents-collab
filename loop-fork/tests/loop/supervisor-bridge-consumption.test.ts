import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeBridgeInbox } from "../../src/loop/bridge-dispatch";
import { appendBridgeMessage } from "../../src/loop/bridge-store";
import {
  SupervisorBridgeConsumptionReconciler,
  type SupervisorBridgeConsumptionRuntime,
} from "../../src/loop/supervisor-bridge-consumption";
import type { SupervisorMessagePhase } from "../../src/loop/supervisor-message-workflow";
import type { SupervisorThreadBoardProjection } from "../../src/loop/supervisor-thread-store";

const WORKFLOW_ID = `supervisor-message:${"a".repeat(64)}`;
const AT = "2026-08-30T09:40:00.000Z";

const revisionFor = (phase: SupervisorMessagePhase): number => {
  if (phase === "acknowledged") {
    return 3;
  }
  return phase === "claimed" ? 2 : 1;
};

const actionFor = (
  phase: SupervisorMessagePhase
): "acknowledge" | "claim" | "none" => {
  if (phase === "claimed") {
    return "acknowledge";
  }
  return phase === "acknowledged" ? "none" : "claim";
};

const board = (
  phase: SupervisorMessagePhase
): SupervisorThreadBoardProjection => ({
  revision: revisionFor(phase),
  schema: "supervisor-thread-board.v1",
  threads: [
    {
      messages: [
        {
          item: {
            acknowledgedAt: phase === "acknowledged" ? AT : null,
            actionRequired: actionFor(phase),
            artifactRefs: [],
            claimedAt: phase === "routed" ? null : AT,
            claimedBy: phase === "routed" ? null : "supervisor:harness",
            deadLetteredAt: null,
            deliveredAt: AT,
            deliveryAttempts: 1,
            escalatedAt: null,
            from: "supervisor:harvto",
            messageId: "message-1",
            nextRetryAt: null,
            phase,
            receivedAt: AT,
            schema: "supervisor-message-board-item.v1",
            threadId: "thread-1",
            to: "supervisor:harness",
            workflowId: WORKFLOW_ID,
          },
          messageKind: "question",
          observedAt: AT,
          schema: "supervisor-thread-message.v1",
        },
      ],
      participants: ["supervisor:harness", "supervisor:harvto"],
      schema: "supervisor-thread.v1",
      threadId: "thread-1",
      updatedAt: AT,
    },
  ],
});

test("claims and acknowledges only after exact driver pull consumption", async () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-bridge-consume-"));
  const runDir = join(root, "run");
  try {
    let phase: SupervisorMessagePhase = "routed";
    const calls: string[] = [];
    const runtime: SupervisorBridgeConsumptionRuntime = {
      acknowledge: (command) => {
        calls.push(`ack:${command.requestId}`);
        phase = "acknowledged";
        return Promise.resolve();
      },
      claim: (command) => {
        calls.push(`claim:${command.requestId}`);
        phase = "claimed";
        return Promise.resolve();
      },
      threads: () => board(phase),
    };
    const reconciler = new SupervisorBridgeConsumptionReconciler({
      bindings: [
        { principal: "principal:harness", supervisorId: "supervisor:harness" },
      ],
      directory: { resolve: () => ({ runDir, target: "codex" }) },
      runtime,
    });
    const message = appendBridgeMessage(
      runDir,
      "supervisor",
      "codex",
      "Perform the bounded Harness action",
      {
        dedupeKey: `${WORKFLOW_ID}:delivery:1`,
        now: AT,
        taskId: WORKFLOW_ID,
        type: "work_request",
      }
    );

    expect(await reconciler.reconcile()).toEqual({
      acknowledged: 0,
      claimed: 0,
      inspected: 0,
    });
    expect(calls).toEqual([]);

    consumeBridgeInbox(runDir, "codex", "accepted by codex app-server");
    expect(await reconciler.reconcile()).toEqual({
      acknowledged: 0,
      claimed: 0,
      inspected: 0,
    });
    expect(calls).toEqual([]);

    appendBridgeMessage(runDir, "supervisor", "codex", message.message, {
      dedupeKey: `${WORKFLOW_ID}:delivery:2`,
      now: "2026-08-30T09:40:01.000Z",
      taskId: WORKFLOW_ID,
      type: "work_request",
    });
    consumeBridgeInbox(runDir, "codex", "read via receive_messages");
    expect(await reconciler.reconcile()).toEqual({
      acknowledged: 1,
      claimed: 1,
      inspected: 1,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toStartWith("claim:bridge-consume:");
    expect(calls[1]).toStartWith("ack:bridge-consume:");

    expect(await reconciler.reconcile()).toEqual({
      acknowledged: 0,
      claimed: 0,
      inspected: 1,
    });
    expect(calls).toHaveLength(2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

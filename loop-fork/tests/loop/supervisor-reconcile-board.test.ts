import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMailboxCommand } from "../../src/loop/mailbox-command";
import { SupervisorBridgeConsumptionReconciler } from "../../src/loop/supervisor-bridge-consumption";
import { SupervisorMailboxConsumptionReconciler } from "../../src/loop/supervisor-mailbox-consumption";
import { mailboxPathFor } from "../../src/loop/supervisor-mailbox-delivery";
import type { GovernedWorkflowCommand } from "../../src/loop/supervisor-message-governance";
import { SupervisorMessageReadModel } from "../../src/loop/supervisor-message-read-model";
import type {
  SupervisorMessagePhase,
  SupervisorMessageProjection,
} from "../../src/loop/supervisor-message-workflow";
import type { SupervisorThreadBoardProjection } from "../../src/loop/supervisor-thread-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-board-")));
  roots.push(root);
  return root;
};

const BOB = "supervisor:bob";
const workflowId = (digit: string) => `supervisor-message:${digit.repeat(64)}`;

const projection = (
  id: string,
  phase: SupervisorMessagePhase
): SupervisorMessageProjection => ({
  acknowledgedAt: phase === "acknowledged" ? "2026-10-11T00:00:02.000Z" : null,
  actionRequired: (
    {
      acknowledged: "none",
      claimed: "acknowledge",
      routed: "claim",
    } as Record<string, SupervisorMessageProjection["actionRequired"]>
  )[phase] as SupervisorMessageProjection["actionRequired"],
  artifactRefs: [],
  claimedAt:
    phase === "claimed" || phase === "acknowledged"
      ? "2026-10-11T00:00:01.000Z"
      : null,
  claimedBy: phase === "claimed" || phase === "acknowledged" ? BOB : null,
  deadLetteredAt: null,
  deliveredAt: "2026-10-11T00:00:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:alice",
  messageId: `message-${id.slice(-4)}`,
  nextRetryAt: null,
  phase,
  receivedAt: "2026-10-11T00:00:00.000Z",
  schema: "supervisor-message-status.v1",
  threadId: `thread-${id.slice(-4)}`,
  to: BOB,
});

/**
 * A runtime whose board is a set of phases; claim and acknowledge move them,
 * and every board read is counted, as the journal-backed runtime would parse
 * or clone on each.
 */
const fakeRuntime = (phases: Map<string, SupervisorMessagePhase>) => {
  const commands: string[] = [];
  let reads = 0;
  const runtime = {
    acknowledge: (command: GovernedWorkflowCommand) => {
      commands.push(`acknowledge ${command.workflowId}`);
      phases.set(command.workflowId, "acknowledged");
      return Promise.resolve();
    },
    claim: (command: GovernedWorkflowCommand) => {
      commands.push(`claim ${command.workflowId}`);
      phases.set(command.workflowId, "claimed");
      return Promise.resolve();
    },
    threads: (): SupervisorThreadBoardProjection => {
      reads += 1;
      const model = new SupervisorMessageReadModel();
      for (const [id, phase] of phases) {
        model.upsert(id, projection(id, phase));
      }
      return {
        revision: reads,
        schema: "supervisor-thread-board.v1",
        threads: model.board().items.map((item) => ({
          messages: [
            {
              item,
              messageKind: "question",
              observedAt: "2026-10-11T00:00:00.000Z",
              schema: "supervisor-thread-message.v1",
            },
          ],
          participants: [item.from, item.to],
          schema: "supervisor-thread.v1",
          threadId: item.threadId,
          updatedAt: "2026-10-11T00:00:00.000Z",
        })),
      };
    },
  };
  return { commands, reads: () => reads, runtime };
};

test("the mailbox reconciler reads the board once per pass however many keys the cursor holds, and again only after it wrote", async () => {
  const root = scratch();
  const settled = ["1", "2", "3", "4"].map(workflowId);
  const fresh = workflowId("5");
  const all = [...settled, fresh];
  const envelopes = all.map((id) => {
    const message = projection(id, "routed");
    return {
      artifactRefs: [],
      at: "2026-10-11T00:00:00.000Z",
      body: "b",
      delivery: "mailbox",
      idempotencyKey: `${id}:delivery:1`,
      messageId: message.messageId,
      target: BOB,
      threadId: message.threadId,
      workflowId: id,
    };
  });
  writeFileSync(
    mailboxPathFor(root, BOB),
    `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
  runMailboxCommand([
    "mailbox",
    "ack",
    "--id",
    BOB,
    "--root",
    root,
    ...all.flatMap((id) => ["--key", `${id}:delivery:1`]),
  ]);
  const phases = new Map<string, SupervisorMessagePhase>([
    ...settled.map((id) => [id, "acknowledged"] as const),
    [fresh, "routed"],
  ]);
  const { commands, reads, runtime } = fakeRuntime(phases);
  const reconciler = new SupervisorMailboxConsumptionReconciler({
    bindings: [
      {
        mailbox: mailboxPathFor(root, BOB),
        principal: "principal:bob",
        supervisorId: BOB,
      },
    ],
    runtime,
  });
  const first = await reconciler.reconcile();
  // The claim is re-read before deciding to acknowledge: the board moved.
  expect(commands).toEqual([`claim ${fresh}`, `acknowledge ${fresh}`]);
  expect(first).toMatchObject({ acknowledged: 1, claimed: 1, inspected: 5 });
  // One read for the pass, one after the claim. The acknowledge ended the
  // pass: nothing read after it.
  expect(reads()).toBe(2);
  // A steady-state pass: five consumed keys, one board read.
  await reconciler.reconcile();
  expect(reads()).toBe(3);
  expect(commands).toHaveLength(2);
});

test("the bridge reconciler reads the board once per pass and re-reads after its claim", async () => {
  const runDir = scratch();
  const ids = ["6", "7", "8"].map(workflowId);
  const lines = ids.flatMap((id, index) => [
    {
      at: "2026-10-11T00:00:00.000Z",
      id: `bridge-${index}`,
      kind: "message",
      message: `work for ${id}`,
      source: "supervisor",
      target: "claude",
      taskId: id,
      type: "work_request",
    },
    {
      at: "2026-10-11T00:00:01.000Z",
      id: `bridge-${index}`,
      kind: "delivered",
      reason: "read via receive_messages",
      source: "supervisor",
      target: "claude",
    },
  ]);
  writeFileSync(
    join(runDir, "bridge.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  const phases = new Map<string, SupervisorMessagePhase>([
    [ids[0] as string, "acknowledged"],
    [ids[1] as string, "routed"],
    [ids[2] as string, "acknowledged"],
  ]);
  const { commands, reads, runtime } = fakeRuntime(phases);
  const reconciler = new SupervisorBridgeConsumptionReconciler({
    bindings: [{ principal: "principal:bob", supervisorId: BOB }],
    directory: { resolve: () => ({ runDir, target: "claude" }) },
    runtime,
  });
  const result = await reconciler.reconcile();
  expect(commands).toEqual([`claim ${ids[1]}`, `acknowledge ${ids[1]}`]);
  expect(result).toMatchObject({ acknowledged: 1, claimed: 1, inspected: 3 });
  // Pass read, after the claim, after the acknowledge (one more key).
  expect(reads()).toBe(3);
  await reconciler.reconcile();
  expect(reads()).toBe(4);
});

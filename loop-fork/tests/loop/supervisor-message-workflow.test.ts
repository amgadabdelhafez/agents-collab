import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  SupervisorMessageCoordinator,
  type SupervisorMessageDeliveryOutcome,
  type SupervisorMessageDeliveryPort,
} from "../../src/loop/supervisor-message-coordinator";
import {
  type SupervisorMessageInput,
  supervisorMessageWorkflowDefinition,
} from "../../src/loop/supervisor-message-workflow";

const ARTIFACT_REF = `artifact://sha256/${"a".repeat(64)}`;
const BODY_SENTINEL = "relay this secret body without human forwarding";
const PATH_SENTINEL = "/Users/amgad/private/message.txt";

const input = (
  overrides: Partial<SupervisorMessageInput> = {}
): SupervisorMessageInput => ({
  artifactRefs: [ARTIFACT_REF],
  body: `${BODY_SENTINEL}\n${PATH_SENTINEL}`,
  dedupeKey: "harvto-to-harness-6f365287",
  from: "supervisor:harvto",
  messageId: "message-6f365287",
  policy: {
    claimTimeoutMs: 1000,
    escalationTimeoutMs: 2000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 500,
  },
  receivedAt: "2026-08-30T03:40:00.000Z",
  threadId: "thread-harvto-harness",
  to: "supervisor:harness",
  ...overrides,
});

const harness = (
  outcomes: SupervisorMessageDeliveryOutcome[] = [{ status: "accepted" }]
) => {
  let now = "2026-08-30T03:40:00.000Z";
  const deliveries: Parameters<SupervisorMessageDeliveryPort["deliver"]>[0][] =
    [];
  const delivery: SupervisorMessageDeliveryPort = {
    deliver(request) {
      deliveries.push(request);
      return Promise.resolve(
        outcomes[Math.min(deliveries.length - 1, outcomes.length - 1)] ?? {
          status: "accepted",
        }
      );
    },
  };
  const port = new InMemoryWorkflowPort({
    definitions: [supervisorMessageWorkflowDefinition],
    now: () => now,
  });
  return {
    coordinator: new SupervisorMessageCoordinator(port, delivery),
    deliveries,
    port,
    setNow(value: string) {
      now = value;
    },
  };
};

describe("SupervisorMessage workflow", () => {
  test("receives, persists, routes, deduplicates, claims, and acknowledges", async () => {
    const state = harness();
    const first = await state.coordinator.receive(input(), "receive-1");
    expect(first.created).toBe(true);
    expect(first.projection).toMatchObject({
      actionRequired: "claim",
      deliveredAt: "2026-08-30T03:40:00.000Z",
      deliveryAttempts: 1,
      phase: "routed",
      to: "supervisor:harness",
    });
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      body: expect.stringContaining(BODY_SENTINEL),
      idempotencyKey: expect.stringContaining(":delivery:1"),
      target: "supervisor:harness",
    });

    const duplicate = await state.coordinator.receive(
      input({ body: "a duplicate must not replace persisted content" }),
      "receive-2"
    );
    expect(duplicate.created).toBe(false);
    expect(state.deliveries).toHaveLength(1);

    const claimed = await state.coordinator.claim(
      first.workflowId,
      "supervisor:harness",
      "claim-1"
    );
    expect(claimed).toMatchObject({
      actionRequired: "acknowledge",
      claimedBy: "supervisor:harness",
      phase: "claimed",
    });
    const acknowledged = await state.coordinator.acknowledge(
      first.workflowId,
      "supervisor:harness",
      "ack-1"
    );
    expect(acknowledged).toMatchObject({
      actionRequired: "none",
      phase: "acknowledged",
    });
    expect((await state.port.inspect(first.workflowId)).status).toBe(
      "completed"
    );

    const events = await state.port.query({
      name: "event_kinds",
      workflowId: first.workflowId,
    });
    expect(events.value).toEqual([
      "received",
      "persisted",
      "routed",
      "delivery-accepted",
      "claimed",
      "acknowledged",
    ]);
  });

  test("retries transient route failures and keeps activity identity stable", async () => {
    const state = harness([
      { reason: "supervisor temporarily offline", status: "transient-failure" },
      { status: "accepted" },
    ]);
    const received = await state.coordinator.receive(input(), "receive-1");
    expect(received.projection).toMatchObject({
      actionRequired: "retry",
      deliveryAttempts: 1,
      nextRetryAt: "2026-08-30T03:40:00.500Z",
      phase: "retry-scheduled",
    });
    state.setNow("2026-08-30T03:40:00.500Z");
    const retried = await state.coordinator.retryDue(
      received.workflowId,
      "retry-1"
    );
    expect(retried).toMatchObject({
      actionRequired: "claim",
      deliveryAttempts: 2,
      phase: "routed",
    });
    expect(state.deliveries.map((entry) => entry.idempotencyKey)).toEqual([
      `${received.workflowId}:delivery:1`,
      `${received.workflowId}:delivery:2`,
    ]);
  });

  test("a due clock tick wakes and delivers a scheduled retry", async () => {
    const state = harness([
      { reason: "temporarily offline", status: "transient-failure" },
      { status: "accepted" },
    ]);
    const received = await state.coordinator.receive(input(), "receive-1");
    state.setNow("2026-08-30T03:40:00.500Z");
    const retried = await state.coordinator.tick(
      received.workflowId,
      "timer-retry-1"
    );
    expect(retried).toMatchObject({
      deliveryAttempts: 2,
      phase: "routed",
    });
    expect(state.deliveries).toHaveLength(2);
  });

  test("dead-letters after delivery policy exhaustion", async () => {
    const state = harness([
      { reason: "offline-1", status: "transient-failure" },
      { reason: "offline-2", status: "transient-failure" },
    ]);
    const received = await state.coordinator.receive(
      input({
        policy: {
          claimTimeoutMs: 1000,
          escalationTimeoutMs: 2000,
          maxDeliveryAttempts: 2,
          retryDelayMs: 500,
        },
      }),
      "receive-1"
    );
    state.setNow("2026-08-30T03:40:00.500Z");
    const exhausted = await state.coordinator.retryDue(
      received.workflowId,
      "retry-1"
    );
    expect(exhausted).toMatchObject({
      actionRequired: "dead-letter",
      deadLetteredAt: "2026-08-30T03:40:00.500Z",
      deliveryAttempts: 2,
      phase: "dead-lettered",
    });
    expect((await state.port.inspect(received.workflowId)).status).toBe(
      "failed"
    );
  });

  test("escalates an unclaimed message once then dead-letters it", async () => {
    const state = harness();
    const received = await state.coordinator.receive(input(), "receive-1");
    state.setNow("2026-08-30T03:40:01.000Z");
    const escalated = await state.coordinator.tick(
      received.workflowId,
      "tick-escalate"
    );
    expect(escalated).toMatchObject({
      actionRequired: "claim",
      escalatedAt: "2026-08-30T03:40:01.000Z",
      phase: "escalated",
    });
    const revision = (await state.port.inspect(received.workflowId)).revision;
    await state.coordinator.tick(received.workflowId, "tick-escalate");
    expect((await state.port.inspect(received.workflowId)).revision).toBe(
      revision
    );

    state.setNow("2026-08-30T03:40:03.000Z");
    const dead = await state.coordinator.tick(
      received.workflowId,
      "tick-dead-letter"
    );
    expect(dead).toMatchObject({
      actionRequired: "dead-letter",
      phase: "dead-lettered",
    });
  });

  test("fresh no-op ticks do not change revision or history", async () => {
    const state = harness();
    const received = await state.coordinator.receive(input(), "receive-1");
    const before = await state.port.inspect(received.workflowId);
    state.setNow("2026-08-30T03:40:00.100Z");
    await state.coordinator.tick(received.workflowId, "early-tick-1");
    state.setNow("2026-08-30T03:40:00.200Z");
    await state.coordinator.tick(received.workflowId, "early-tick-2");
    const after = await state.port.inspect(received.workflowId);
    expect(after.revision).toBe(before.revision);
    expect(after.history).toEqual(before.history);
  });

  test("refuses foreign claims and invalid timestamps or artifact paths", async () => {
    const state = harness();
    const received = await state.coordinator.receive(input(), "receive-1");
    await expect(
      state.coordinator.claim(
        received.workflowId,
        "supervisor:foreign",
        "claim-foreign"
      )
    ).rejects.toMatchObject({ code: "invalid-command" });

    await expect(
      harness().coordinator.receive(
        input({ receivedAt: "2026-02-30T00:00:00.000Z" }),
        "invalid-date"
      )
    ).rejects.toMatchObject({ code: "invalid-command" });
    await expect(
      harness().coordinator.receive(
        input({ artifactRefs: [PATH_SENTINEL] }),
        "invalid-artifact"
      )
    ).rejects.toMatchObject({ code: "invalid-command" });
  });

  test("cancels idempotently and projection never contains body or local paths", async () => {
    const state = harness();
    const received = await state.coordinator.receive(input(), "receive-1");
    const projectionJson = JSON.stringify(received.projection);
    expect(projectionJson).not.toContain(BODY_SENTINEL);
    expect(projectionJson).not.toContain(PATH_SENTINEL);

    const canceled = await state.coordinator.cancel(
      received.workflowId,
      "superseded by authority decision",
      "cancel-1"
    );
    expect(canceled).toMatchObject({
      actionRequired: "none",
      phase: "canceled",
    });
    await state.port.cancel({
      reason: "same logical command",
      requestId: "cancel-1",
      workflowId: received.workflowId,
    });
    expect(
      (await state.port.inspect(received.workflowId)).history.at(-1)?.kind
    ).toBe("canceled");
  });

  test("refuses cancellation after completed and failed terminal states", async () => {
    const completed = harness();
    const received = await completed.coordinator.receive(input(), "receive-1");
    await completed.coordinator.claim(
      received.workflowId,
      "supervisor:harness",
      "claim-1"
    );
    await completed.coordinator.acknowledge(
      received.workflowId,
      "supervisor:harness",
      "ack-1"
    );
    await expect(
      completed.coordinator.cancel(
        received.workflowId,
        "too late",
        "cancel-completed"
      )
    ).rejects.toMatchObject({ code: "invalid-state" });

    const failed = harness([
      { reason: "permanent refusal", status: "permanent-failure" },
    ]);
    const dead = await failed.coordinator.receive(
      input({ dedupeKey: "dead-letter-cancel-test" }),
      "receive-dead"
    );
    expect(dead.projection.phase).toBe("dead-lettered");
    await expect(
      failed.coordinator.cancel(dead.workflowId, "too late", "cancel-failed")
    ).rejects.toMatchObject({ code: "invalid-state" });
  });
});

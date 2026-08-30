import { createHash } from "node:crypto";
import type { SupervisorMessageInput } from "./supervisor-message-workflow";
import type { SupervisorMessageReplayFixture } from "./workflow-replay-corpus";

const ARTIFACT_REF = `artifact://sha256/${"b".repeat(64)}`;

const input = (id: string): SupervisorMessageInput => ({
  artifactRefs: [ARTIFACT_REF],
  body: "fixture body must never enter replay observations /Users/private.txt",
  dedupeKey: `replay-${id}`,
  from: "supervisor:source",
  messageId: `message-${id}`,
  policy: {
    claimTimeoutMs: 1000,
    escalationTimeoutMs: 2000,
    maxDeliveryAttempts: 2,
    retryDelayMs: 500,
  },
  receivedAt: "2026-08-30T04:00:00.000Z",
  threadId: `thread-${id}`,
  to: "supervisor:target",
});

const deliveryKeys = (id: string, attempts: number): string[] => {
  const workflowId = `supervisor-message:${createHash("sha256")
    .update(`replay-${id}`)
    .digest("hex")}`;
  return Array.from(
    { length: attempts },
    (_, index) => `${workflowId}:delivery:${index + 1}`
  );
};

export const supervisorMessageReplayFixtures: readonly SupervisorMessageReplayFixture[] =
  [
    {
      deliveryOutcomes: [{ status: "accepted" }],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("duplicate-receive", 1),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "delivery-accepted",
          "claimed",
          "acknowledged",
        ],
        executionStatus: "completed",
        historyLength: 4,
        phase: "acknowledged",
        revision: 4,
      },
      expectedDigest:
        "f5831e9f2ae2916bd4908dd2fb1d1cce058f205383965919a88d08c147cbc64d",
      id: "duplicate-receive",
      input: input("duplicate-receive"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { kind: "restart-worker" },
        { kind: "receive", requestId: "receive-2" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        {
          claimant: "supervisor:target",
          kind: "acknowledge",
          requestId: "ack-1",
        },
      ],
    },
    {
      deliveryOutcomes: [
        { reason: "temporary outage", status: "transient-failure" },
        { status: "accepted" },
      ],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("crash-retry", 2),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "retry-scheduled",
          "retry-due",
          "delivery-accepted",
          "claimed",
          "acknowledged",
        ],
        executionStatus: "completed",
        historyLength: 6,
        phase: "acknowledged",
        revision: 6,
      },
      expectedDigest:
        "bb7ba2a9035230721aa2378558c37e632be147484d330499039db2c1bd8b27a8",
      id: "crash-retry",
      input: input("crash-retry"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { kind: "restart-worker" },
        { at: "2026-08-30T04:00:00.500Z", kind: "set-clock" },
        { kind: "tick", requestId: "retry-tick-1" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        {
          claimant: "supervisor:target",
          kind: "acknowledge",
          requestId: "ack-1",
        },
      ],
    },
    {
      deliveryOutcomes: [{ status: "accepted" }],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("delayed-claim", 1),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "delivery-accepted",
          "escalated",
          "claimed",
          "acknowledged",
        ],
        executionStatus: "completed",
        historyLength: 5,
        phase: "acknowledged",
        revision: 5,
      },
      expectedDigest:
        "03a1a9a62c1f1e014d39b9d670eed007288c4dc11286db129e647d7aeb944ab8",
      id: "delayed-claim",
      input: input("delayed-claim"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { at: "2026-08-30T04:00:01.000Z", kind: "set-clock" },
        { kind: "tick", requestId: "escalate-1" },
        { kind: "restart-worker" },
        { at: "2026-08-30T04:00:01.100Z", kind: "set-clock" },
        { kind: "tick", requestId: "post-escalation-noop" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        {
          claimant: "supervisor:target",
          kind: "acknowledge",
          requestId: "ack-1",
        },
      ],
    },
    {
      deliveryOutcomes: [{ status: "accepted" }],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("cancellation-replay", 1),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "delivery-accepted",
          "canceled:superseded",
        ],
        executionStatus: "canceled",
        historyLength: 3,
        phase: "canceled",
        revision: 3,
      },
      expectedDigest:
        "fe226528f66bd3d5582053dead3911d2df8a48cb6db91e160205ae25d8a01b68",
      id: "cancellation-replay",
      input: input("cancellation-replay"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { kind: "cancel", reason: "superseded", requestId: "cancel-1" },
        { kind: "restart-worker" },
        { kind: "cancel", reason: "superseded", requestId: "cancel-1" },
      ],
    },
    {
      deliveryOutcomes: [
        { reason: "offline-1", status: "transient-failure" },
        { reason: "offline-2", status: "transient-failure" },
      ],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("retry-exhaustion", 2),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "retry-scheduled",
          "retry-due",
          "dead-lettered",
        ],
        executionStatus: "failed",
        historyLength: 4,
        phase: "dead-lettered",
        revision: 4,
      },
      expectedDigest:
        "525ee3372f97ca488a0d7d1911375b337ab542debe06e6242615b7b75488feb6",
      id: "retry-exhaustion",
      input: input("retry-exhaustion"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { at: "2026-08-30T04:00:00.500Z", kind: "set-clock" },
        { kind: "restart-worker" },
        { kind: "tick", requestId: "retry-tick-1" },
      ],
    },
    {
      deliveryOutcomes: [{ status: "accepted" }],
      expected: {
        deliveryIdempotencyKeys: deliveryKeys("worker-upgrade", 1),
        eventKinds: [
          "received",
          "persisted",
          "routed",
          "delivery-accepted",
          "claimed",
          "acknowledged",
        ],
        executionStatus: "completed",
        historyLength: 4,
        phase: "acknowledged",
        revision: 4,
      },
      expectedDigest:
        "66d51814a420dd7cdbcdc603eab663d8785bbf54f74c55be4e3392bfbd640bcd",
      id: "worker-upgrade",
      input: input("worker-upgrade"),
      steps: [
        { kind: "receive", requestId: "receive-1" },
        { kind: "upgrade-worker", version: "supervisor-message.v2-worker" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        { claimant: "supervisor:target", kind: "claim", requestId: "claim-1" },
        {
          claimant: "supervisor:target",
          kind: "acknowledge",
          requestId: "ack-1",
        },
      ],
    },
  ] as const;

export const SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST =
  "5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd";

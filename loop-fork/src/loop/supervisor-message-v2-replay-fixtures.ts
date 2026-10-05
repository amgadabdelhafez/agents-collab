import {
  SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA,
  SUPERVISOR_MESSAGE_V2_SCHEMA,
  type SupervisorMessageV2ReplayFixture,
} from "./supervisor-message-v2-contract";

const ARTIFACT_REF = `artifact://sha256/${"c".repeat(64)}`;

/**
 * Contract-only fixtures. They deliberately do not enter the V1 runtime: V2
 * workflow registration and dual-version replay are separate migration gates.
 */
export const supervisorMessageV2ReplayFixtures: readonly SupervisorMessageV2ReplayFixture[] =
  [
    {
      expectedScope: {
        principal: "principal:tenant-v2-source",
        tenantId: "tenant:tenant-v2",
      },
      id: "tenant-scope-required",
      input: {
        artifactRefs: [ARTIFACT_REF],
        body: "V2 fixture body remains inside the future private workflow boundary.",
        dedupeKey: "v2-tenant-scope-required",
        from: "supervisor:source",
        messageId: "message-v2-tenant-scope-required",
        policy: {
          claimTimeoutMs: 1000,
          escalationTimeoutMs: 2000,
          maxDeliveryAttempts: 2,
          retryDelayMs: 500,
        },
        principal: "principal:tenant-v2-source",
        receivedAt: "2026-09-20T05:00:00.000Z",
        schema: SUPERVISOR_MESSAGE_V2_SCHEMA,
        tenantId: "tenant:tenant-v2",
        threadId: "thread-v2-tenant-scope-required",
        to: "supervisor:target",
      },
      schema: SUPERVISOR_MESSAGE_V2_REPLAY_FIXTURE_SCHEMA,
    },
  ];

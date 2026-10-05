import { expect, test } from "bun:test";
import { SupervisorMessageV2BridgeDeliveryPort } from "../../src/loop/supervisor-message-v2-bridge-delivery";

test("V2 bridge adapter carries one governed request and does not claim recipient consumption", async () => {
  const seen: unknown[] = [];
  const port = new SupervisorMessageV2BridgeDeliveryPort({
    deliver: (request) => {
      seen.push(request);
      return Promise.resolve({ status: "accepted" as const });
    },
  });

  await expect(
    port.deliver({
      artifactRefs: [`artifact://sha256/${"a".repeat(64)}`],
      body: "bounded work",
      deliveryAttempt: 1,
      deliveryId: `supervisor-message-delivery:v2:${"b".repeat(64)}`,
      idempotencyKey: "a2a:v2:delivery",
      messageId: "raw-message-id",
      principal: "principal:bridge-adapter-test",
      schema: "supervisor-message-delivery.v2",
      target: "supervisor:harness",
      tenantId: "tenant:bridge-adapter-test",
      threadId: "thread:v2:bridge-adapter-test",
      workflowId: `supervisor-message-workflow:v2:${"c".repeat(64)}`,
    })
  ).resolves.toEqual({ status: "accepted" });
  expect(seen).toEqual([
    {
      artifactRefs: [`artifact://sha256/${"a".repeat(64)}`],
      body: "bounded work",
      idempotencyKey: "a2a:v2:delivery",
      messageId: "raw-message-id",
      target: "supervisor:harness",
      threadId: "thread:v2:bridge-adapter-test",
      workflowId: `supervisor-message-workflow:v2:${"c".repeat(64)}`,
    },
  ]);
});

import { expect, test } from "bun:test";
import { createSupervisorMessageV2RecipientAssignmentResolver } from "../../src/loop/supervisor-message-v2-recipient-assignment";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";

test("recipient assignment joins configured identity, durable workflow, and ready sender-scoped session", async () => {
  const scope = { tenantId: "tenant:one", principal: "principal:sender" };
  let reads = 0;
  let ready = true;
  let current = true;
  const resolve = createSupervisorMessageV2RecipientAssignmentResolver({
    tenantId: scope.tenantId,
    principalForRecipient: (recipient) =>
      recipient === "supervisor:seat" ? "principal:seat" : undefined,
    ledger: {
      recipientAssignment: ({ recipient, workflowId }) => {
        reads++;
        return Promise.resolve(
          recipient === "supervisor:seat" && workflowId === "workflow:owned"
            ? scope
            : undefined
        );
      },
    },
    sessions: {
      current: () =>
        Promise.resolve(
          current
            ? ({
                ...scope,
                recipient: "supervisor:seat",
              } as SupervisorSessionDescriptorV2)
            : undefined
        ),
      assertReady: () =>
        ready ? Promise.resolve(undefined) : Promise.reject(new Error("stale")),
    },
  });
  const input = {
    identity: { principal: "principal:seat", supervisorId: "supervisor:seat" },
    workflowId: "workflow:owned",
  };
  expect(
    await resolve({
      ...input,
      identity: { ...input.identity, principal: "principal:foreign" },
    })
  ).toBeUndefined();
  expect(reads).toBe(0);
  expect(
    await resolve({ ...input, workflowId: "workflow:foreign" })
  ).toBeUndefined();
  expect(await resolve(input)).toEqual(scope);
  ready = false;
  expect(await resolve(input)).toBeUndefined();
  ready = true;
  current = false;
  expect(await resolve(input)).toBeUndefined();
});

import { expect, test } from "bun:test";
import type { SupervisorMessageV2Projection } from "../../src/loop/supervisor-message-v2-contract";
import { createSupervisorMessageV2RecipientHttpHandler } from "../../src/loop/supervisor-message-v2-http";

test("recipient route binds claimant and original scope outside JSON and never claims work completion", async () => {
  const commands: unknown[] = [];
  let assignments = 0;
  const handler = createSupervisorMessageV2RecipientHttpHandler({
    pathname: "/recipient",
    authenticator: {
      authenticate: (request) =>
        request.headers.get("authorization") === "Bearer fixture"
          ? { principal: "principal:seat", supervisorId: "supervisor:seat" }
          : undefined,
    },
    resolveAssignment: ({ identity, workflowId }) => {
      assignments++;
      return Promise.resolve(
        identity.supervisorId === "supervisor:seat" &&
          workflowId === "workflow:owned"
          ? { tenantId: "tenant:owned", principal: "principal:sender" }
          : undefined
      );
    },
    governance: {
      claim: (command) => {
        commands.push(command);
        return Promise.resolve({
          phase: "claimed",
          claimedAt: "2026-10-05T06:00:00Z",
          acknowledgedAt: null,
        } as SupervisorMessageV2Projection);
      },
      acknowledge: () => Promise.reject(new Error("fixture refusal")),
    },
  });
  const send = (body: unknown, authenticated = true) =>
    handler(
      new Request("http://local/recipient", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer fixture" } : {}),
        },
        body: JSON.stringify(body),
      })
    );
  const command = {
    operation: "claim",
    requestId: "request:one",
    workflowId: "workflow:owned",
  };
  expect((await send(command, false)).status).toBe(401);
  expect(assignments).toBe(0);
  expect(
    (await send({ ...command, claimant: "supervisor:other" })).status
  ).toBe(400);
  expect(
    (await send({ ...command, workflowId: "workflow:foreign" })).status
  ).toBe(403);
  expect(commands).toHaveLength(0);
  const accepted = await send(command);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    phase: "claimed",
    workResultCompleted: false,
  });
  expect(commands).toEqual([
    {
      claimant: "supervisor:seat",
      requestId: "request:one",
      workflowId: "workflow:owned",
      trustedScope: { tenantId: "tenant:owned", principal: "principal:sender" },
    },
  ]);
  expect((await send({ ...command, operation: "acknowledge" })).status).toBe(
    409
  );
});

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

test("recipient route caps oversized bodies after auth without buffering them", async () => {
  const MiB = 1024 * 1024;
  const order: string[] = [];
  const metered = () => {
    const meter = { cancelled: false, pulled: 0 };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (meter.pulled >= MiB) {
            controller.close();
            return;
          }
          meter.pulled += 1024;
          controller.enqueue(new Uint8Array(1024).fill(0x20));
        },
        cancel() {
          meter.cancelled = true;
        },
      },
      // No read-ahead: every pulled chunk was requested by the handler.
      { highWaterMark: 0 }
    );
    return { meter, stream };
  };
  const handler = createSupervisorMessageV2RecipientHttpHandler({
    pathname: "/recipient",
    authenticator: {
      authenticate: (request) => {
        order.push("authenticate");
        return request.headers.get("authorization") === "Bearer fixture"
          ? { principal: "principal:seat", supervisorId: "supervisor:seat" }
          : undefined;
      },
    },
    resolveAssignment: () => {
      order.push("resolve");
      return Promise.resolve(undefined);
    },
    governance: {
      claim: () => Promise.reject(new Error("must not claim")),
      acknowledge: () => Promise.reject(new Error("must not acknowledge")),
    },
  });
  const send = (
    body: BodyInit,
    headers: Record<string, string> = {},
    authenticated = true
  ) =>
    handler(
      new Request("http://local/recipient", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer fixture" } : {}),
          ...headers,
        },
        body,
        duplex: "half",
      } as RequestInit)
    );

  const unauthenticated = metered();
  expect(
    (
      await send(
        unauthenticated.stream,
        { "content-length": String(MiB) },
        false
      )
    ).status
  ).toBe(401);
  expect(unauthenticated.meter.pulled).toBe(0);

  const declared = metered();
  const declaredResponse = await send(declared.stream, {
    "content-length": String(MiB),
  });
  expect(declaredResponse.status).toBe(413);
  expect(await declaredResponse.json()).toEqual({ code: "body-too-large" });
  expect(declared.meter.pulled).toBe(0);

  const streamed = metered();
  expect((await send(streamed.stream)).status).toBe(413);
  expect(streamed.meter.pulled).toBeLessThanOrEqual(8192 + 1024);
  expect(streamed.meter.cancelled).toBe(true);
  expect(order).toEqual(["authenticate", "authenticate", "authenticate"]);

  const command = JSON.stringify({
    operation: "claim",
    requestId: "request:one",
    workflowId: "workflow:owned",
  });
  expect((await send(command)).status).toBe(403);
  expect((await send(`${command}${" ".repeat(8192)}`)).status).toBe(413);
});

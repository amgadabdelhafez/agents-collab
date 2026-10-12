import { expect, test } from "bun:test";
import { orchestrationAuthenticator } from "../../src/loop/loop-orchestration-server";
import type { OrchestrationTokenService } from "../../src/loop/orchestration-token-service";
import type { SupervisorMessageV2Projection } from "../../src/loop/supervisor-message-v2-contract";
import { createSupervisorMessageV2RecipientHttpHandler } from "../../src/loop/supervisor-message-v2-http";
import { SupervisorMessageV2RecipientTooEarlyError } from "../../src/loop/supervisor-message-v2-runtime";
import { WorkflowError } from "../../src/loop/workflow-port";

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

test("recipient route names an early claim or acknowledge, with when to retry, and keeps every other lifecycle refusal opaque", async () => {
  let refusal: unknown;
  const handler = createSupervisorMessageV2RecipientHttpHandler({
    pathname: "/recipient",
    authenticator: {
      authenticate: () => ({
        principal: "principal:seat",
        supervisorId: "supervisor:seat",
      }),
    },
    resolveAssignment: () =>
      Promise.resolve({
        principal: "principal:sender",
        tenantId: "tenant:owned",
      }),
    governance: {
      acknowledge: () => Promise.reject(refusal),
      claim: () => Promise.reject(refusal),
    },
  });
  const send = async (operation: "acknowledge" | "claim") => {
    const response = await handler(
      new Request("http://local/recipient", {
        body: JSON.stringify({
          operation,
          requestId: `request:${operation}`,
          workflowId: "workflow:owned",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    return { body: await response.json(), status: response.status };
  };
  refusal = new SupervisorMessageV2RecipientTooEarlyError(
    "delivery-not-recorded",
    new Date(Date.now() + 20_000).toISOString()
  );
  const early = await send("claim");
  expect(early.status).toBe(409);
  expect(early.body.code).toBe("delivery-not-recorded");
  expect(early.body.retryAfterMs).toBeGreaterThan(15_000);
  expect(early.body.retryAfterMs).toBeLessThanOrEqual(20_000);
  refusal = new SupervisorMessageV2RecipientTooEarlyError("not-claimed", null);
  expect(await send("acknowledge")).toEqual({
    body: { code: "not-claimed" },
    status: 409,
  });
  // Anything else (a workflow refusal, an engine error) stays one code, and
  // none of its message reaches the response.
  for (const other of [
    new WorkflowError("invalid-state", "detail: session:secret"),
    new Error("engine detail"),
  ]) {
    refusal = other;
    expect(await send("claim")).toEqual({
      body: { code: "lifecycle-command-refused" },
      status: 409,
    });
  }
});

// 2026-10-12 live repro: a session enrolled as the RA1 role id
// `supervisor:harvto-llc/harvto/backend` streamed its V2 message but its
// recipient ACK answered 401, while the flat `supervisor:harness` ACKed. The
// route's identity check used a reference pattern without '/'.
test("a session token for a role id or a flat id claims and acknowledges its delivered V2 message", async () => {
  const supervisors = [
    {
      principal: "principal:harvto-backend",
      role: {
        project: "backend",
        repoKey: "harvto-llc/harvto",
        role: "supervisor",
      },
      supervisorId: "supervisor:harvto-llc/harvto/backend",
      tokenEnv: "HARVTO_BACKEND_TOKEN",
    },
    {
      principal: "principal:harness",
      role: {
        project: "harness",
        repoKey: "amgad/harness-engineering",
        role: "supervisor",
      },
      supervisorId: "supervisor:harness",
      tokenEnv: "HARNESS_TOKEN",
    },
  ];
  // The session token service stand-in: a token names the address it enrolled.
  const tokens = {
    verify: (token: string) =>
      token.startsWith("session:")
        ? { address: token.slice("session:".length) }
        : undefined,
  } as unknown as Pick<OrchestrationTokenService, "verify">;
  const commands: { claimant: string; operation: string }[] = [];
  const projection = (phase: "acknowledged" | "claimed") =>
    Promise.resolve({
      acknowledgedAt: phase === "acknowledged" ? "2026-10-12T00:00:01Z" : null,
      claimedAt: "2026-10-12T00:00:00Z",
      phase,
    } as SupervisorMessageV2Projection);
  const handler = createSupervisorMessageV2RecipientHttpHandler({
    pathname: "/recipient",
    authenticator: orchestrationAuthenticator(
      { hostname: "0.0.0.0", supervisors } as Parameters<
        typeof orchestrationAuthenticator
      >[0],
      {},
      tokens
    ),
    resolveAssignment: ({ identity, workflowId }) =>
      Promise.resolve(
        workflowId === "workflow:delivered" &&
          supervisors.some(
            (entry) =>
              entry.supervisorId === identity.supervisorId &&
              entry.principal === identity.principal
          )
          ? { principal: "principal:sender", tenantId: "tenant:owned" }
          : undefined
      ),
    governance: {
      claim: (command) => {
        commands.push({ claimant: command.claimant, operation: "claim" });
        return projection("claimed");
      },
      acknowledge: (command) => {
        commands.push({ claimant: command.claimant, operation: "acknowledge" });
        return projection("acknowledged");
      },
    },
  });
  const send = (address: string, operation: "acknowledge" | "claim") =>
    handler(
      new Request("http://local/recipient", {
        body: JSON.stringify({
          operation,
          requestId: `request:${operation}`,
          workflowId: "workflow:delivered",
        }),
        headers: {
          authorization: `Bearer session:${address}`,
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
  for (const { supervisorId } of supervisors) {
    const claimed = await send(supervisorId, "claim");
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ phase: "claimed" });
    const acknowledged = await send(supervisorId, "acknowledge");
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({
      phase: "acknowledged",
      workResultCompleted: false,
    });
  }
  expect(commands).toEqual([
    { claimant: "supervisor:harvto-llc/harvto/backend", operation: "claim" },
    {
      claimant: "supervisor:harvto-llc/harvto/backend",
      operation: "acknowledge",
    },
    { claimant: "supervisor:harness", operation: "claim" },
    { claimant: "supervisor:harness", operation: "acknowledge" },
  ]);
  // A token for an address that is not configured is still refused.
  expect(
    (await send("supervisor:harvto-llc/harvto/other", "claim")).status
  ).toBe(401);
  expect(commands).toHaveLength(4);
});

import { expect, test } from "bun:test";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { createSupervisorA2AHttpHandler } from "../../src/loop/a2a-supervisor-http";

const MiB = 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

/** A body that counts what the handler actually pulled from the client. */
const meteredBody = (totalBytes: number) => {
  const meter = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (meter.pulled >= totalBytes) {
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

const createHandler = () => {
  const order: string[] = [];
  const handler = createSupervisorA2AHttpHandler({
    authenticator: {
      authenticate: (request) => {
        order.push("authenticate");
        return request.headers.get("authorization") === "Bearer fixture"
          ? { principal: "principal:control", supervisorId: "supervisor:seat" }
          : undefined;
      },
    },
    // Oversized requests must never reach the protocol handler; an in-limit
    // malformed body is answered by the SDK's own JSON-RPC parse error.
    handler: {} as A2ARequestHandler,
    tenant: "tenant:owned",
  });
  return { handler, order };
};

const post = (
  body: BodyInit,
  headers: Record<string, string> = {},
  authenticated = true
) =>
  new Request("http://local/a2a", {
    body,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer fixture" } : {}),
      ...headers,
    },
    method: "POST",
  } as RequestInit);

test("A2A JSON-RPC route authenticates before refusing a declared oversized body unread", async () => {
  const { handler, order } = createHandler();
  const unauthenticated = meteredBody(MiB);
  const refused = await handler(
    post(unauthenticated.stream, { "content-length": String(MiB) }, false)
  );
  expect(refused.status).toBe(401);
  expect(unauthenticated.meter.pulled).toBe(0);
  expect(order).toEqual(["authenticate"]);

  const declared = meteredBody(MiB);
  const response = await handler(
    post(declared.stream, { "content-length": String(MiB) })
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { code: "body-too-large" },
  });
  expect(declared.meter.pulled).toBe(0);
  expect(order).toEqual(["authenticate", "authenticate"]);
});

test("A2A JSON-RPC route stops reading an undeclared oversized body at the cap", async () => {
  const { handler } = createHandler();
  const streamed = meteredBody(MiB);
  const response = await handler(post(streamed.stream));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { code: "body-too-large" },
  });
  // Bounded by the 64 KiB cap plus the one chunk that crossed it.
  expect(streamed.meter.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 1024);
  expect(streamed.meter.cancelled).toBe(true);
});

test("A2A JSON-RPC route still hands an in-limit body to the SDK", async () => {
  const { handler } = createHandler();
  const inLimit = await handler(post("{not json"));
  expect(inLimit.status).toBe(200);
  // The SDK's own parse failure proves the bytes reached the transport.
  expect(await inLimit.json()).toMatchObject({
    error: { code: -32_602, message: expect.stringContaining("JSON Parse") },
    jsonrpc: "2.0",
  });
  const exact = await handler(post(`{${" ".repeat(MAX_BODY_BYTES - 1)}`));
  expect(exact.status).toBe(200);
  const over = await handler(post(`{${" ".repeat(MAX_BODY_BYTES)}`));
  expect(over.status).toBe(413);
});

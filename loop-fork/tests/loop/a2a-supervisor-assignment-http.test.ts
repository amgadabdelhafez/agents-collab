import { expect, test } from "bun:test";
import { createSupervisorA2AAssignmentHttpHandler } from "../../src/loop/a2a-supervisor-assignment-http";

const MiB = 1024 * 1024;

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
      // No read-ahead: every pulled chunk was requested by the handler.
    },
    { highWaterMark: 0 }
  );
  return { meter, stream };
};

const createHandler = () => {
  const order: string[] = [];
  const bindings: unknown[] = [];
  const handler = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) => {
        order.push("authenticate");
        return request.headers.get("authorization") === "Bearer fixture"
          ? { principal: "principal:control", supervisorId: "supervisor:seat" }
          : undefined;
      },
    },
    bind: (_scope, binding) => {
      bindings.push(binding);
      return Promise.resolve();
    },
    pathname: "/assign",
    principal: "principal:control",
    tenant: "tenant:owned",
  });
  return { bindings, handler, order };
};

const post = (
  body: BodyInit,
  headers: Record<string, string> = {},
  authenticated = true
) =>
  new Request("http://local/assign", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer fixture" } : {}),
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit);

const binding = {
  a2aTaskId: "task:one",
  graphTaskId: "graph-task:one",
  graphWorkflowId: "graph:one",
  messageWorkflowId: "message:one",
  recipient: "supervisor:seat",
};

test("assignment route refuses a declared oversized body before reading it, after auth", async () => {
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
  expect(await response.json()).toEqual({ code: "body-too-large" });
  expect(declared.meter.pulled).toBe(0);
});

test("assignment route stops reading an undeclared oversized body at the cap", async () => {
  const { bindings, handler } = createHandler();
  const streamed = meteredBody(MiB);
  const response = await handler(post(streamed.stream));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ code: "body-too-large" });
  // Bounded by the 8 KiB cap plus the one chunk that crossed it.
  expect(streamed.meter.pulled).toBeLessThanOrEqual(8192 + 1024);
  expect(streamed.meter.cancelled).toBe(true);
  expect(bindings).toHaveLength(0);
});

test("assignment route still accepts an in-limit binding", async () => {
  const { bindings, handler } = createHandler();
  const response = await handler(post(JSON.stringify(binding)));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ assigned: true });
  expect(bindings).toEqual([binding]);
  const padded = `${JSON.stringify(binding)}${" ".repeat(8192)}`;
  expect((await handler(post(padded))).status).toBe(413);
});

import { expect, test } from "bun:test";
import {
  createSupervisorA2AAssignmentHttpHandler,
  createSupervisorA2AResultGraphStartHttpHandler,
} from "../../src/loop/a2a-supervisor-assignment-http";

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

/** The control principal, and an authenticated caller that is not it. */
const IDENTITIES: Record<
  string,
  { principal: string; supervisorId: string } | undefined
> = {
  "Bearer fixture": {
    principal: "principal:control",
    supervisorId: "supervisor:seat",
  },
  "Bearer other": {
    principal: "principal:other",
    supervisorId: "supervisor:x",
  },
};

test("assignment route lists only what its service returns for the authenticated control principal's tenant, and refuses GET when it has no list", async () => {
  const scopes: unknown[] = [];
  const handler = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    pathname: "/assign",
    principal: "principal:control",
    tenant: "tenant:owned",
    unpublishable: (scope) => {
      scopes.push(scope);
      return Promise.resolve([
        {
          a2aTaskId: "task:one",
          graphTaskId: "node",
          graphWorkflowId: "task-graph:chosen",
          messageWorkflowId: "message:one",
          reason: "body-chosen-graph" as const,
          tenantId: "tenant:owned",
        },
      ]);
    },
  });
  const get = (authorization?: string) =>
    handler(
      new Request("http://local/assign", {
        headers: authorization ? { authorization } : {},
      })
    );
  expect((await get()).status).toBe(401);
  expect((await get("Bearer other")).status).toBe(403);
  expect(scopes).toEqual([]);
  const listed = await get("Bearer fixture");
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(await listed.json()).toEqual({
    schema: "supervisor-result-assignment-status.v1",
    unpublishable: [
      {
        a2aTaskId: "task:one",
        graphTaskId: "node",
        graphWorkflowId: "task-graph:chosen",
        messageWorkflowId: "message:one",
        reason: "body-chosen-graph",
      },
    ],
  });
  expect(scopes).toEqual([
    { principal: "principal:control", tenantId: "tenant:owned" },
  ]);
  const { handler: postOnly } = createHandler();
  expect(
    (
      await postOnly(
        new Request("http://local/assign", {
          headers: { authorization: "Bearer fixture" },
        })
      )
    ).status
  ).toBe(405);
});

test("assignment route GET names the seats that are not enrolled and the recipients a readiness outage defers, only to the control principal", async () => {
  let reads = 0;
  const handler = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    deliveryStatus: () => {
      reads += 1;
      return {
        notEnrolled: ["supervisor:harness-peer"],
        readinessOutage: ["supervisor:harness"],
      };
    },
    pathname: "/assign",
    principal: "principal:control",
    tenant: "tenant:owned",
    unpublishable: () => Promise.resolve([]),
  });
  const get = (authorization?: string) =>
    handler(
      new Request("http://local/assign", {
        headers: authorization ? { authorization } : {},
      })
    );
  const unauthenticated = await get();
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.text()).not.toContain("supervisor:");
  const other = await get("Bearer other");
  expect(other.status).toBe(403);
  expect(await other.text()).not.toContain("supervisor:harness");
  expect(reads).toBe(0);
  const listed = await get("Bearer fixture");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    notEnrolled: ["supervisor:harness-peer"],
    readinessOutage: ["supervisor:harness"],
    schema: "supervisor-result-assignment-status.v1",
    unpublishable: [],
  });
  // A route with only the delivery status still answers GET.
  const statusOnly = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    deliveryStatus: () => ({ notEnrolled: [], readinessOutage: [] }),
    pathname: "/assign",
    principal: "principal:control",
    tenant: "tenant:owned",
  });
  const only = await statusOnly(
    new Request("http://local/assign", {
      headers: { authorization: "Bearer fixture" },
    })
  );
  expect(only.status).toBe(200);
  expect(await only.json()).toEqual({
    notEnrolled: [],
    readinessOutage: [],
    schema: "supervisor-result-assignment-status.v1",
  });
});

test("assignment route reports quarantined recovery records only to the authenticated control principal, for its tenant", async () => {
  const scopes: unknown[] = [];
  const handler = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    pathname: "/assign",
    principal: "principal:control",
    recoveryQuarantine: (scope) => {
      scopes.push(scope);
      return Promise.resolve([
        {
          at: "2026-10-05T01:02:03.000Z",
          by: "operator-a",
          reason: "start keeps failing",
          recipient: "supervisor:seat",
          tenantId: "tenant:owned",
          workflowId: "message:one",
        },
      ]);
    },
    tenant: "tenant:owned",
    unpublishable: () => Promise.resolve([]),
  });
  const get = (authorization?: string) =>
    handler(
      new Request("http://local/assign", {
        headers: authorization ? { authorization } : {},
      })
    );
  expect((await get()).status).toBe(401);
  expect((await get("Bearer other")).status).toBe(403);
  expect(scopes).toEqual([]);
  const listed = await get("Bearer fixture");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    recoveryQuarantine: [
      {
        at: "2026-10-05T01:02:03.000Z",
        by: "operator-a",
        reason: "start keeps failing",
        recipient: "supervisor:seat",
        workflowId: "message:one",
      },
    ],
    schema: "supervisor-result-assignment-status.v1",
    unpublishable: [],
  });
  expect(scopes).toEqual([
    { principal: "principal:control", tenantId: "tenant:owned" },
  ]);
  // The quarantine list alone makes the route inspectable.
  const quarantineOnly = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    pathname: "/assign",
    principal: "principal:control",
    recoveryQuarantine: () => Promise.resolve([]),
    tenant: "tenant:owned",
  });
  const alone = await quarantineOnly(
    new Request("http://local/assign", {
      headers: { authorization: "Bearer fixture" },
    })
  );
  expect(alone.status).toBe(200);
  expect(await alone.json()).toEqual({
    recoveryQuarantine: [],
    schema: "supervisor-result-assignment-status.v1",
  });
  // A failing read is reported without its cause.
  const failing = createSupervisorA2AAssignmentHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    bind: () => Promise.resolve(),
    pathname: "/assign",
    principal: "principal:control",
    recoveryQuarantine: () => Promise.reject(new Error("postgres://secret")),
    tenant: "tenant:owned",
    unpublishable: () => Promise.resolve([]),
  });
  const refused = await failing(
    new Request("http://local/assign", {
      headers: { authorization: "Bearer fixture" },
    })
  );
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({ code: "status-unavailable" });
});

const createStartHandler = (
  start: Parameters<
    typeof createSupervisorA2AResultGraphStartHttpHandler
  >[0]["start"] = (_scope, command) =>
    Promise.resolve({
      graphWorkflowId: `derived-for:${command.messageWorkflowId}`,
      receipt: {
        created: true,
        duplicate: false,
        requestId: command.requestId,
        revision: 1,
        workflowId: `derived-for:${command.messageWorkflowId}`,
        workflowType: "task-graph.v1",
      } as never,
    })
) => {
  const calls: unknown[] = [];
  const handler = createSupervisorA2AResultGraphStartHttpHandler({
    authenticator: {
      authenticate: (request) =>
        IDENTITIES[request.headers.get("authorization") ?? ""],
    },
    pathname: "/result-graph",
    principal: "principal:control",
    tenant: "tenant:owned",
    start: (scope, command) => {
      calls.push({ scope, command });
      return start(scope, command);
    },
  });
  return { calls, handler };
};

const startRequest = (
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer fixture" },
  path = "/result-graph",
  method = "POST"
) =>
  new Request(`http://local${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST"
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });

const startBody = {
  input: { schema: "task-graph.v1", graphId: "g", nodes: [] },
  messageWorkflowId: "message:one",
  requestId: "start-one",
};

test("result graph route starts the message's graph for the authenticated control principal, never under a body-chosen id", async () => {
  const { calls, handler } = createStartHandler();
  const response = await handler(startRequest(startBody));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    schema: "supervisor-result-graph-start-receipt.v1",
    messageWorkflowId: "message:one",
    graphWorkflowId: "derived-for:message:one",
    created: true,
  });
  expect(calls).toEqual([
    {
      scope: { principal: "principal:control", tenantId: "tenant:owned" },
      command: startBody,
    },
  ]);
  // A body may not name the graph id, or anything else.
  for (const invalid of [
    { ...startBody, graphWorkflowId: "supervisor-result-graph:v3:chosen" },
    { ...startBody, input: [] },
    { ...startBody, messageWorkflowId: "" },
    { ...startBody, requestId: "has space" },
    { input: startBody.input, messageWorkflowId: "message:one" },
    "not json",
  ]) {
    const refused = await handler(startRequest(invalid));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      code: "invalid-result-graph-start",
    });
  }
  expect(calls).toHaveLength(1);
});

test("result graph route refuses unauthenticated, foreign-principal, wrong-method, wrong-path, non-JSON and oversized requests before starting anything", async () => {
  const { calls, handler } = createStartHandler();
  expect((await handler(startRequest(startBody, {}))).status).toBe(401);
  expect(
    (await handler(startRequest(startBody, { authorization: "Bearer other" })))
      .status
  ).toBe(403);
  expect(
    (
      await handler(
        startRequest(startBody, { authorization: "Bearer fixture" }, "/x")
      )
    ).status
  ).toBe(404);
  expect(
    (
      await handler(
        startRequest(
          startBody,
          { authorization: "Bearer fixture" },
          "/result-graph",
          "GET"
        )
      )
    ).status
  ).toBe(405);
  expect(
    (
      await handler(
        startRequest(startBody, {
          authorization: "Bearer fixture",
          "content-type": "text/plain",
        })
      )
    ).status
  ).toBe(415);
  const oversized = await handler(
    startRequest({
      ...startBody,
      input: { ...startBody.input, pad: "x".repeat(64 * 1024) },
    })
  );
  expect(oversized.status).toBe(413);
  expect(calls).toEqual([]);
});

test("result graph route reports a refused start without its cause", async () => {
  const { handler } = createStartHandler(() =>
    Promise.reject(new Error("postgres://user:secret@host/db refused"))
  );
  const refused = await handler(startRequest(startBody));
  expect(refused.status).toBe(409);
  const text = await refused.text();
  expect(JSON.parse(text)).toEqual({ code: "result-graph-start-refused" });
  expect(text).not.toContain("secret");
});

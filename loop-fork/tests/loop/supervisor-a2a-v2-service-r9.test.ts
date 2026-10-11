// r9 (T3): the all-supervisor routes and the lease-aware routing of the A2A V2
// service, against fakes of the T1 lease store and the T2 endpoint port. The
// locator resolver is the real server resolver over a scratch home, so the
// traversal, symlink-escape, foreign-manifest and non-loopback-URL refusals
// are the contract's own.

import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Task, TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import { FROM_METADATA_KEY } from "../../src/loop/a2a-supervisor-adapter";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import { A2A_V2_SESSION_REQUEST_SCHEMAS } from "../../src/loop/a2a-v2-routes-contract";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  a2aV2MessageTaskState,
  createA2AV2MessageStatusHandler,
  createA2AV2SessionRoutesHandler,
  createA2AV2SupervisorIngressGate,
  createSupervisorA2AV2Service,
  SupervisorA2AV2RecipientRouting,
} from "../../src/loop/supervisor-a2a-v2-service";
import {
  createSupervisorEndpointLocatorResolver,
  decideSupervisorEndpointLeaseClaim,
  decideSupervisorEndpointLeaseFence,
  resolveSupervisorEndpointLease,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocator,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointLeaseExpiresAt,
  supervisorEndpointLeaseHolderSummary,
  supervisorEndpointLocatorRefused,
  supervisorEndpointRoots,
} from "../../src/loop/supervisor-endpoint-lease";
import type { SupervisorMessageV2DeliveryEnvelope } from "../../src/loop/supervisor-message-v2-contract";
import { SupervisorMessageV2StartIntentScopeError } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { SUPERVISOR_ENDPOINT_REASONS } from "../../src/loop/supervisor-message-v2-endpoint-contract";
import {
  type SupervisorMessageV2DeliveryOutcome,
  SupervisorMessageV2ReadinessUnavailableError,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";

const TENANT = "tenant:r9";
const ALPHA = "supervisor:alpha";
const BETA = "supervisor:beta";
const PRINCIPALS: Record<string, string> = {
  [ALPHA]: "principal:alpha",
  [BETA]: "principal:beta",
};
const principalFor = (recipient: string) => PRINCIPALS[recipient];
const TOKENS: Record<string, string> = {
  "token-alpha": ALPHA,
  "token-beta": BETA,
};
const authenticator = {
  authenticate: (request: Request) => {
    const token = (request.headers.get("authorization") ?? "").replace(
      "Bearer ",
      ""
    );
    const supervisorId = TOKENS[token];
    return supervisorId
      ? { principal: PRINCIPALS[supervisorId] as string, supervisorId }
      : undefined;
  },
};
const NOW = new Date("2026-10-11T12:00:00.000Z");
const REMOTE_URLS = [
  "ws://192.168.1.18:4500",
  "ws://localhost.evil.example:4500",
  "ws://127.0.0.1.nip.io:4500",
  "ws://[::ffff:127.0.0.1]:4500",
  "ws://[::1]:4500",
  "ws://2130706433:4500",
  "ws://127.0.0.1",
  "wss://127.0.0.1:4500",
  "ws://user:pw@127.0.0.1:4500",
  "ws://127.0.0.1:4500/redirect?to=ws://192.168.1.18:4500",
  "ws://127.0.0.1:4500#x",
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** A scratch server home with one run of `alpha` and one of `beta`. */
const serverHome = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "r9-t3-home-")));
  roots.push(home);
  const run = (
    repoId: string,
    runId: string,
    manifest: Record<string, unknown>
  ) => {
    const dir = join(home, ".loop", "runs", repoId, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ repoId, runId, ...manifest })
    );
    return dir;
  };
  run("repo-1", "run-alpha", {
    a2aSupervisorId: ALPHA,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "thread-alpha",
  });
  run("repo-1", "run-beta", { a2aSupervisorId: BETA });
  // Codex URLs delivery must never dial: not loopback, a hostname that only
  // starts like one, IPv6-mapped, no explicit port, wss, userinfo, and a
  // path or query that could carry a redirect.
  for (const [index, url] of REMOTE_URLS.entries()) {
    run("repo-1", `run-remote-${index}`, {
      a2aSupervisorId: ALPHA,
      codexRemoteUrl: url,
      codexThreadId: "thread-remote",
    });
  }
  // Outside the runs root: a symlinked run dir must never resolve to it.
  const outside = join(home, "outside", "run-x");
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(outside, "manifest.json"),
    JSON.stringify({
      a2aSupervisorId: ALPHA,
      repoId: "repo-1",
      runId: "run-escape",
    })
  );
  symlinkSync(outside, join(home, ".loop", "runs", "repo-1", "run-escape"));
  const resolveLocator = createSupervisorEndpointLocatorResolver({
    fs: {
      readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
      realpath: (path) => realpathSync(path),
    },
    roots: supervisorEndpointRoots(home),
  });
  return { home, resolveLocator, run };
};

/**
 * T1's contract in memory: claim and fence decisions from the contract, the
 * locator resolved on claim and re-resolved on renew, release never resolves.
 */
const fakeLeaseStore = (resolveLocator: SupervisorEndpointLocatorResolver) => {
  const rows = new Map<string, SupervisorEndpointLeaseV2>();
  const calls: { input: unknown; operation: string }[] = [];
  let failure: Error | undefined;
  const store: SupervisorEndpointLeaseStore = {
    claim(input) {
      calls.push({ input, operation: "claim" });
      if (failure) {
        return Promise.reject(failure);
      }
      try {
        resolveLocator(input.locator, input.recipient);
      } catch (error) {
        return Promise.resolve(supervisorEndpointLocatorRefused(error));
      }
      const current = rows.get(input.recipient);
      const decision = decideSupervisorEndpointLeaseClaim(current, input, NOW);
      if (!decision.allowed) {
        return Promise.resolve({ current: decision.current, status: "held" });
      }
      const lease: SupervisorEndpointLeaseV2 = {
        descriptorId: `descriptor:${input.recipient}`,
        descriptorRevision: (current?.descriptorRevision ?? 0) + 1,
        epoch: decision.nextEpoch,
        expiresAt: supervisorEndpointLeaseExpiresAt(NOW, input.ttlMs),
        holderRef: input.holderRef,
        kind: input.locator.kind,
        locator: input.locator,
        principal: input.scope.principal,
        recipient: input.recipient,
        releasedAt: null,
        schema: "supervisor-endpoint-lease.v2",
        tenantId: input.scope.tenantId,
      };
      rows.set(input.recipient, lease);
      return Promise.resolve({
        descriptor: {} as never,
        lease,
        previous: current
          ? supervisorEndpointLeaseHolderSummary(current, NOW)
          : null,
        status: "claimed",
        tookOver: decision.tookOver,
      });
    },
    list: (tenantId) =>
      Promise.resolve(
        [...rows.values()].filter(
          (row) => row.tenantId === tenantId && row.releasedAt === null
        )
      ),
    release(input) {
      calls.push({ input, operation: "release" });
      const current = rows.get(input.recipient);
      const fence = decideSupervisorEndpointLeaseFence(current, input.fence);
      if (fence === "released" && current) {
        return Promise.resolve({
          changed: false,
          lease: current,
          status: "released",
        });
      }
      if (fence !== "ok" || !current) {
        return Promise.resolve({
          reason: fence as "absent",
          status: "fenced",
        });
      }
      const lease = { ...current, releasedAt: NOW.toISOString() };
      rows.set(input.recipient, lease);
      return Promise.resolve({ changed: true, lease, status: "released" });
    },
    renew(input) {
      calls.push({ input, operation: "renew" });
      const current = rows.get(input.recipient);
      const fence = decideSupervisorEndpointLeaseFence(current, input.fence);
      if (fence !== "ok" || !current) {
        return Promise.resolve({ reason: fence as "absent", status: "fenced" });
      }
      try {
        resolveLocator(current.locator, current.recipient);
      } catch (error) {
        return Promise.resolve(supervisorEndpointLocatorRefused(error));
      }
      const lease = {
        ...current,
        expiresAt: supervisorEndpointLeaseExpiresAt(NOW, input.ttlMs),
      };
      rows.set(input.recipient, lease);
      return Promise.resolve({
        descriptor: {} as never,
        lease,
        status: "renewed",
      });
    },
    resolve: (_tenantId, recipient) =>
      Promise.resolve(resolveSupervisorEndpointLease(rows.get(recipient), NOW)),
  };
  return {
    calls,
    fail: (error: Error | undefined) => {
      failure = error;
    },
    rows,
    store,
  };
};

const LOOP_RUN: SupervisorEndpointLocator = {
  kind: "loop-run",
  repoId: "repo-1",
  runId: "run-alpha",
  seat: "claude",
};

const sessionRequest = (
  body: unknown,
  token = "token-alpha",
  init: { contentType?: string; method?: string } = {}
) =>
  new Request("http://127.0.0.1:7321/a2a/v2/sessions/claim", {
    body: init.method === "GET" ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": init.contentType ?? "application/json",
    },
    method: init.method ?? "POST",
  });

const claimBody = (overrides: Record<string, unknown> = {}) => ({
  holderRef: "holder:alpha-1",
  locator: LOOP_RUN,
  schema: A2A_V2_SESSION_REQUEST_SCHEMAS.claim,
  sessionRef: "session:claude-alpha",
  supervisorId: ALPHA,
  ...overrides,
});

const sessionsFixture = () => {
  const home = serverHome();
  const leases = fakeLeaseStore(home.resolveLocator);
  const logs: string[] = [];
  let available = true;
  const handle = createA2AV2SessionRoutesHandler({
    authenticator,
    leases: () => (available ? leases.store : undefined),
    log: (line) => logs.push(line),
    principalForRecipient: principalFor,
    resolveLocator: home.resolveLocator,
    sessionTtlMs: 60_000,
    tenant: TENANT,
  });
  return {
    ...home,
    handle,
    leases,
    logs,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
};

const bodyOf = async (response: Response) => ({
  body: (await response.json()) as Record<string, unknown>,
  status: response.status,
});

test("session routes: method, media type, bearer and strict body are checked before any store call", async () => {
  const f = sessionsFixture();
  expect(
    (
      await f.handle(
        sessionRequest(claimBody(), "token-alpha", { method: "GET" }),
        "claim"
      )
    ).status
  ).toBe(405);
  expect(
    (
      await f.handle(
        sessionRequest(claimBody(), "token-alpha", {
          contentType: "text/plain",
        }),
        "claim"
      )
    ).status
  ).toBe(415);
  expect(
    await bodyOf(await f.handle(sessionRequest(claimBody(), "nope"), "claim"))
  ).toEqual({
    body: { error: { code: "unauthenticated" } },
    status: 401,
  });
  const throwing = createA2AV2SessionRoutesHandler({
    authenticator: {
      authenticate: () => {
        throw new Error("token store exploded at /secret/path");
      },
    },
    leases: () => f.leases.store,
    principalForRecipient: principalFor,
    resolveLocator: f.resolveLocator,
    sessionTtlMs: 60_000,
    tenant: TENANT,
  });
  expect(
    await bodyOf(await throwing(sessionRequest(claimBody()), "claim"))
  ).toEqual({
    body: { error: { code: "authentication-failed" } },
    status: 500,
  });
  // SECURITY: a locator is ids only. A path or URL key, a traversal or an
  // absolute id is refused by the strict decode, before the resolver.
  for (const locator of [
    { ...LOOP_RUN, runDir: "/Users/someone/.loop/runs/repo-1/run-alpha" },
    { ...LOOP_RUN, runId: "../run-beta" },
    { ...LOOP_RUN, repoId: "/etc" },
    { ...LOOP_RUN, runId: ".." },
    { kind: "claude-channel", sessionDir: "/tmp/x", sessionId: "s1" },
    {
      kind: "codex-thread",
      remoteUrl: "ws://evil:1",
      repoId: "repo-1",
      runId: "run-alpha",
      threadId: "t",
    },
  ]) {
    expect(
      await bodyOf(
        await f.handle(sessionRequest(claimBody({ locator })), "claim")
      )
    ).toEqual({ body: { error: { code: "request-invalid" } }, status: 400 });
  }
  expect(
    (await f.handle(sessionRequest(claimBody({ extra: 1 })), "claim")).status
  ).toBe(400);
  expect(
    (
      await f.handle(
        new Request("http://127.0.0.1/a2a/v2/sessions/claim", {
          body: "{not json",
          headers: {
            authorization: "Bearer token-alpha",
            "content-type": "application/json",
          },
          method: "POST",
        }),
        "claim"
      )
    ).status
  ).toBe(400);
  expect(f.leases.calls).toEqual([]);
});

test("session routes: a token acts only for its own supervisor, and only when a lease store answers", async () => {
  const f = sessionsFixture();
  // beta's token cannot claim for alpha.
  expect(
    await bodyOf(
      await f.handle(sessionRequest(claimBody(), "token-beta"), "claim")
    )
  ).toEqual({ body: { error: { code: "identity-mismatch" } }, status: 403 });
  // An identity whose principal is not the configured binding is refused.
  const rebound = createA2AV2SessionRoutesHandler({
    authenticator: {
      authenticate: () => ({
        principal: "principal:beta",
        supervisorId: ALPHA,
      }),
    },
    leases: () => f.leases.store,
    principalForRecipient: principalFor,
    resolveLocator: f.resolveLocator,
    sessionTtlMs: 60_000,
    tenant: TENANT,
  });
  expect((await rebound(sessionRequest(claimBody()), "claim")).status).toBe(
    403
  );
  expect(f.leases.calls).toEqual([]);
  f.setAvailable(false);
  expect(
    await bodyOf(await f.handle(sessionRequest(claimBody()), "claim"))
  ).toEqual({
    body: { error: { code: "v2-unavailable" } },
    status: 503,
  });
});

test("session claim resolves the locator for the authenticated supervisor first: symlink escape, a foreign manifest and a non-loopback Codex URL are 403 with no detail", async () => {
  const f = sessionsFixture();
  const refusals: [SupervisorEndpointLocator, string][] = [
    [{ ...LOOP_RUN, runId: "run-escape" }, "not-contained"],
    [{ ...LOOP_RUN, runId: "run-beta" }, "foreign-manifest"],
    [{ ...LOOP_RUN, runId: "run-missing" }, "unresolved"],
    ...REMOTE_URLS.map((_url, index): [SupervisorEndpointLocator, string] => [
      {
        kind: "codex-thread",
        repoId: "repo-1",
        runId: `run-remote-${index}`,
        threadId: "thread-remote",
      },
      "remote-url-refused",
    ]),
    [
      {
        kind: "codex-thread",
        repoId: "repo-1",
        runId: "run-alpha",
        threadId: "thread-other",
      },
      "thread-mismatch",
    ],
  ];
  for (const [locator, reason] of refusals) {
    const sessionRef =
      locator.kind === "codex-thread"
        ? `session:${locator.threadId}`
        : "session:claude-alpha";
    const response = await f.handle(
      sessionRequest(claimBody({ locator, sessionRef })),
      "claim"
    );
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: { code: "locator-refused" } });
    expect(text).not.toContain(f.home);
    expect(f.logs.at(-1)).toBe(
      `A2A V2 session claim refused for ${ALPHA}: locator ${reason}`
    );
  }
  // The route refused every one before the store saw it.
  expect(f.leases.calls).toEqual([]);
  for (const line of f.logs) {
    expect(line).not.toContain(f.home);
  }
});

test("session claim, renew and release: seat scope, default TTL, receipts without the locator, held, takeover and fences", async () => {
  const f = sessionsFixture();
  const claimed = await bodyOf(
    await f.handle(sessionRequest(claimBody()), "claim")
  );
  expect(claimed).toEqual({
    body: {
      descriptorRevision: 1,
      epoch: 1,
      expiresAt: "2026-10-11T12:01:00.000Z",
      holderRef: "holder:alpha-1",
      kind: "loop-run",
      operation: "claim",
      releasedAt: null,
      schema: "supervisor-endpoint-session-receipt.v2",
      supervisorId: ALPHA,
      tookOver: false,
    },
    status: 200,
  });
  expect(f.leases.calls[0]?.input).toMatchObject({
    recipient: ALPHA,
    scope: { principal: "principal:alpha", tenantId: TENANT },
    ttlMs: 60_000,
  });
  // A second holder is held off, then takes over only when asked.
  const held = await bodyOf(
    await f.handle(
      sessionRequest(claimBody({ holderRef: "holder:alpha-2" })),
      "claim"
    )
  );
  expect(held).toEqual({
    body: {
      error: {
        code: "lease-held",
        current: {
          epoch: 1,
          expiresAt: "2026-10-11T12:01:00.000Z",
          holderRef: "holder:alpha-1",
          state: "live",
        },
      },
    },
    status: 409,
  });
  const taken = await bodyOf(
    await f.handle(
      sessionRequest(
        claimBody({ holderRef: "holder:alpha-2", takeover: true, ttlMs: 5000 })
      ),
      "claim"
    )
  );
  expect(taken.body).toMatchObject({ epoch: 2, tookOver: true });
  // The evicted holder is fenced.
  const renewBody = (epoch: number, holderRef: string) => ({
    epoch,
    holderRef,
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.renew,
    supervisorId: ALPHA,
  });
  expect(
    await bodyOf(
      await f.handle(sessionRequest(renewBody(1, "holder:alpha-1")), "renew")
    )
  ).toEqual({
    body: { error: { code: "lease-fenced", reason: "epoch-mismatch" } },
    status: 409,
  });
  expect(
    (
      await bodyOf(
        await f.handle(sessionRequest(renewBody(2, "holder:alpha-2")), "renew")
      )
    ).body
  ).toMatchObject({ epoch: 2, operation: "renew" });
  // Renew re-resolves the STORED locator: a run that now names another
  // supervisor refuses it (and extends nothing).
  f.run("repo-1", "run-alpha", { a2aSupervisorId: BETA });
  expect(
    await bodyOf(
      await f.handle(sessionRequest(renewBody(2, "holder:alpha-2")), "renew")
    )
  ).toEqual({ body: { error: { code: "locator-refused" } }, status: 403 });
  // Release never resolves: the holder can always let go, once.
  const releaseBody = {
    epoch: 2,
    holderRef: "holder:alpha-2",
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.release,
    supervisorId: ALPHA,
  };
  const released = await bodyOf(
    await f.handle(sessionRequest(releaseBody), "release")
  );
  expect(released.body).toMatchObject({ changed: true, operation: "release" });
  expect(released.body.releasedAt).toBe(NOW.toISOString());
  expect(
    (await bodyOf(await f.handle(sessionRequest(releaseBody), "release"))).body
  ).toMatchObject({ changed: false });
  // No receipt carries a locator or a path.
  for (const call of [claimed, taken, released]) {
    expect(JSON.stringify(call.body)).not.toContain("run-alpha");
    expect(JSON.stringify(call.body)).not.toContain("locator");
  }
});

test("session routes map a store outage, or any driver text, to 503 with a fixed code", async () => {
  const f = sessionsFixture();
  f.leases.fail(new SupervisorMessageV2ReadinessUnavailableError());
  expect(
    await bodyOf(await f.handle(sessionRequest(claimBody()), "claim"))
  ).toEqual({
    body: { error: { code: "v2-unavailable" } },
    status: 503,
  });
  f.leases.fail(
    new Error("connect ECONNREFUSED postgres://loop:pw@127.0.0.1:55432")
  );
  const response = await f.handle(sessionRequest(claimBody()), "claim");
  const text = await response.text();
  expect(response.status).toBe(503);
  expect(text).not.toContain("postgres");
});

const ingressRequest = (
  body: unknown,
  token = "token-alpha",
  method = "POST"
) =>
  new Request("http://127.0.0.1:7321/a2a/v2/supervisors/beta", {
    body: method === "GET" ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
  });

const sendMessage = (from: unknown) => ({
  id: 1,
  jsonrpc: "2.0",
  method: "SendMessage",
  params: {
    message: {
      contextId: "ctx",
      messageId: "m-1",
      metadata: from === undefined ? {} : { [FROM_METADATA_KEY]: from },
      parts: [{ text: "hello" }],
      role: "ROLE_USER",
    },
  },
});

test("supervisor ingress gate: harness.dev/from must be the authenticated supervisor and a receive grant must hold, or the SDK never sees the request", async () => {
  const granted = new Set([`principal:alpha|${ALPHA}|${BETA}`]);
  const gate = createA2AV2SupervisorIngressGate({
    authenticator,
    mayReceive: ({ from, principal, to }) =>
      granted.has(`${principal}|${from}|${to}`),
  });
  const seen: { body: string; identity: unknown }[] = [];
  const sdk = async (request: Request, identity?: unknown) => {
    seen.push({ body: await request.text(), identity });
    return new Response("sdk", { status: 200 });
  };
  const refused = async (body: unknown, token?: string) =>
    bodyOf(await gate(ingressRequest(body, token), BETA, sdk));
  const mismatch = {
    body: { error: { code: "identity-mismatch" } },
    status: 403,
  };
  expect(await refused(sendMessage(BETA))).toEqual(mismatch);
  expect(await refused(sendMessage(undefined))).toEqual(mismatch);
  expect(await refused(sendMessage(["supervisor:alpha"]))).toEqual(mismatch);
  // The right sender, but no grant for this pair (beta -> beta is not granted,
  // nor is alpha under beta's principal).
  expect(await refused(sendMessage(BETA), "token-beta")).toEqual(mismatch);
  expect(
    await bodyOf(
      await gate(ingressRequest(sendMessage(ALPHA)), "supervisor:gamma", sdk)
    )
  ).toEqual(mismatch);
  // A message smuggled under another method is gated the same way.
  expect(
    await refused({ ...sendMessage(BETA), method: "SendStreamingMessage" })
  ).toEqual(mismatch);
  expect(await refused({ ...sendMessage(BETA), method: "Other" })).toEqual(
    mismatch
  );
  // A sending method is gated even when it carries no readable message.
  for (const params of [{}, { message: null }, { message: "text" }]) {
    expect(await refused({ ...sendMessage(ALPHA), params })).toEqual(mismatch);
  }
  expect(await refused([sendMessage(ALPHA)])).toEqual({
    body: { error: { code: "request-invalid" } },
    status: 400,
  });
  expect(await refused(sendMessage(ALPHA), "nope")).toEqual({
    body: { error: { code: "unauthenticated" } },
    status: 401,
  });
  expect(seen).toEqual([]);
  // Allowed: the SDK gets the same body and the authenticated identity.
  const allowed = await gate(ingressRequest(sendMessage(ALPHA)), BETA, sdk);
  expect(allowed.status).toBe(200);
  expect(seen).toEqual([
    {
      body: JSON.stringify(sendMessage(ALPHA)),
      identity: { principal: "principal:alpha", supervisorId: ALPHA },
    },
  ]);
  // A request that sends nothing (a task read) needs no grant.
  const read = {
    id: 2,
    jsonrpc: "2.0",
    method: "GetTask",
    params: { id: "t-1" },
  };
  expect(
    (await gate(ingressRequest(read, "token-beta"), ALPHA, sdk)).status
  ).toBe(200);
  // A non-POST goes to the SDK adapter unauthenticated (it answers 405).
  await gate(ingressRequest(undefined, "token-alpha", "GET"), BETA, sdk);
  expect(seen.at(-1)?.identity).toBeUndefined();
});

test("message status answers only the sender's own messages, and keeps delivery, ACK and completion apart", async () => {
  const asked: unknown[] = [];
  let state: TaskState | undefined = TaskState.TASK_STATE_WORKING;
  let fail = false;
  const handle = createA2AV2MessageStatusHandler({
    authenticator,
    status: (scope, workflowId) => {
      asked.push({ scope, workflowId });
      if (fail) {
        return Promise.reject(new Error("temporal at 192.168.1.18:7233 down"));
      }
      return Promise.resolve(
        scope.principal === "principal:alpha" &&
          workflowId === "supervisor-message:v2:abc"
          ? {
              acknowledgedAt: null,
              deliveredAt: "2026-10-11T11:00:00.000Z",
              phase: "routed" as const,
              to: BETA,
            }
          : undefined
      );
    },
    taskState: () => Promise.resolve(state),
    tenant: TENANT,
  });
  const get = (
    token: string,
    id = "supervisor-message:v2:abc",
    method = "GET"
  ) =>
    handle(
      new Request(
        `http://127.0.0.1/a2a/v2/messages/${encodeURIComponent(id)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          method,
        }
      ),
      id
    );
  expect(await bodyOf(await get("token-alpha"))).toEqual({
    body: {
      acknowledgedAt: null,
      deliveredAt: "2026-10-11T11:00:00.000Z",
      messageId: "supervisor-message:v2:abc",
      phase: "routed",
      schema: "supervisor-message-sender-status.v2",
      taskState: "TASK_STATE_WORKING",
      to: BETA,
      workResultCompleted: false,
    },
    status: 200,
  });
  // Read in exactly {route tenant, authenticated principal}.
  expect(asked[0]).toEqual({
    scope: { principal: "principal:alpha", tenantId: TENANT },
    workflowId: "supervisor-message:v2:abc",
  });
  // Another principal's message is indistinguishable from an absent one.
  expect(await bodyOf(await get("token-beta"))).toEqual({
    body: { error: { code: "not-found" } },
    status: 404,
  });
  expect((await get("token-alpha", "supervisor-message:v2:nope")).status).toBe(
    404
  );
  state = TaskState.TASK_STATE_COMPLETED;
  expect((await bodyOf(await get("token-alpha"))).body).toMatchObject({
    taskState: "TASK_STATE_COMPLETED",
    workResultCompleted: true,
  });
  state = undefined;
  expect((await bodyOf(await get("token-alpha"))).body).toMatchObject({
    taskState: null,
    workResultCompleted: false,
  });
  expect((await get("nope")).status).toBe(401);
  expect((await get("token-alpha", undefined, "POST")).status).toBe(405);
  fail = true;
  const outage = await get("token-alpha");
  expect(outage.status).toBe(503);
  expect(await outage.text()).not.toContain("192.168");
});

test("message task state is read from the sender's own tasks, across pages", async () => {
  const store = new InMemoryTaskStore();
  const pages: number[] = [];
  const paged = {
    ...store,
    list: (params: { pageToken: string }, _context: unknown) => {
      pages.push(Number(params.pageToken || "0"));
      const page = Number(params.pageToken || "0");
      const tasks: Task[] =
        page < 2
          ? [
              {
                artifacts: [],
                contextId: "c",
                history: [],
                id: `t-${page}`,
                metadata: { [WORKFLOW_IDS_METADATA_KEY]: [`other-${page}`] },
                status: { state: TaskState.TASK_STATE_WORKING } as never,
              } as Task,
            ]
          : [
              {
                artifacts: [],
                contextId: "c",
                history: [],
                id: "t-2",
                metadata: { [WORKFLOW_IDS_METADATA_KEY]: ["first", "wanted"] },
                status: { state: TaskState.TASK_STATE_COMPLETED } as never,
              } as Task,
            ];
      return Promise.resolve({
        nextPageToken: page < 2 ? String(page + 1) : "",
        pageSize: 100,
        tasks,
        totalSize: 3,
      });
    },
  } as never;
  expect(
    await a2aV2MessageTaskState(
      paged,
      { principal: "principal:alpha", tenantId: TENANT },
      "wanted"
    )
  ).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(pages).toEqual([0, 1, 2]);
  expect(
    await a2aV2MessageTaskState(
      paged,
      { principal: "principal:alpha", tenantId: TENANT },
      "absent"
    )
  ).toBeUndefined();
});

const envelope = (target: string): SupervisorMessageV2DeliveryEnvelope => ({
  artifactRefs: [],
  body: "hi",
  deliveryAttempt: 1,
  deliveryId: "d-1",
  idempotencyKey: "k-1",
  messageId: "m-1",
  principal: "principal:alpha",
  schema: "supervisor-message-delivery.v2",
  target,
  tenantId: TENANT,
  threadId: "th-1",
  workflowId: "w-1",
});

const routingFixture = (options: { endpoint?: boolean } = {}) => {
  const home = serverHome();
  const leases = fakeLeaseStore(home.resolveLocator);
  const legacyDelivered: string[] = [];
  const legacyReady: string[] = [];
  const endpointCalls: string[] = [];
  let leaseDown = false;
  const routing = new SupervisorA2AV2RecipientRouting({
    delivery: {
      deliver: (value) => {
        legacyDelivered.push(value.target);
        return Promise.resolve({ status: "accepted" });
      },
    },
    ...(options.endpoint
      ? {
          endpoint: {
            deliver: (value) => {
              endpointCalls.push(`deliver ${value.target}`);
              return Promise.resolve({ status: "accepted" });
            },
            readiness: {
              assertReady: (_scope: unknown, recipient: string) => {
                endpointCalls.push(`ready ${recipient}`);
                return Promise.resolve();
              },
              notEnrolled: () => [],
              notEnrolledSince: (recipient: string) =>
                recipient === BETA ? 7 : undefined,
              readiness: () =>
                Promise.resolve({ state: "mailbox-ready" as const }),
            },
          },
        }
      : {}),
    enrollment: {
      notEnrolledSince: (recipient) => (recipient === ALPHA ? 3 : undefined),
    },
    hasMailbox: (recipient) => recipient === "supervisor:mailbox",
    leases: {
      list: (tenantId) => leases.store.list(tenantId),
      resolve: (tenantId, recipient) =>
        leaseDown
          ? Promise.reject(new Error("driver text"))
          : leases.store.resolve(tenantId, recipient),
    },
    legacySeats: [ALPHA],
    sessions: {
      assertReady: (_scope, recipient) => {
        legacyReady.push(recipient);
        return Promise.resolve();
      },
    },
  });
  return {
    ...home,
    endpointCalls,
    leases,
    legacyDelivered,
    legacyReady,
    routing,
    setLeaseDown: (value: boolean) => {
      leaseDown = value;
    },
  };
};

const scope = { principal: "principal:alpha", tenantId: TENANT };

test("recipient routing: an r8 seat with no lease row keeps r8's readiness and delivery; mailbox-held and leaseless seats follow the routing table", async () => {
  const f = routingFixture();
  await f.routing.assertReady(scope, ALPHA);
  expect(await f.routing.deliver(envelope(ALPHA))).toEqual({
    status: "accepted",
  });
  expect(f.legacyReady).toEqual([ALPHA]);
  expect(f.legacyDelivered).toEqual([ALPHA]);
  // A mailbox-only supervisor: mailbox-ready, delivered through the mailbox.
  await f.routing.assertReady(scope, "supervisor:mailbox");
  expect(await f.routing.deliver(envelope("supervisor:mailbox"))).toEqual({
    status: "accepted",
  });
  expect(f.legacyDelivered).toEqual([ALPHA, "supervisor:mailbox"]);
  // No lease and no mailbox: nowhere to deliver.
  await expect(f.routing.assertReady(scope, BETA)).rejects.toThrow(
    SUPERVISOR_ENDPOINT_REASONS.noEndpoint
  );
  expect(await f.routing.deliver(envelope(BETA))).toEqual({
    reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
    status: "transient-failure",
  } satisfies SupervisorMessageV2DeliveryOutcome);
  expect(f.legacyReady).toEqual([ALPHA]);
});

test("recipient routing: a lease moves even an r8 seat to the lease rule; without T2 a live lease is unready and never falls through to the mailbox", async () => {
  const f = routingFixture();
  const claim = (recipient: string, holderRef: string, ttlMs = 60_000) =>
    f.leases.store.claim({
      holderRef,
      locator: {
        ...LOOP_RUN,
        runId: recipient === ALPHA ? "run-alpha" : "run-beta",
      },
      recipient,
      scope: { principal: principalFor(recipient) as string, tenantId: TENANT },
      sessionRef: "session:s",
      ttlMs,
    });
  expect((await claim(ALPHA, "holder:a")).status).toBe("claimed");
  await expect(f.routing.assertReady(scope, ALPHA)).rejects.toThrow(
    SUPERVISOR_ENDPOINT_REASONS.probeFailed
  );
  expect(await f.routing.deliver(envelope(ALPHA))).toEqual({
    reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
    status: "transient-failure",
  });
  // An expired lease defers.
  const row = f.leases.rows.get(ALPHA) as SupervisorEndpointLeaseV2;
  f.leases.rows.set(ALPHA, { ...row, expiresAt: "2026-10-11T11:00:00.000Z" });
  await expect(f.routing.assertReady(scope, ALPHA)).rejects.toThrow(
    SUPERVISOR_ENDPOINT_REASONS.leaseExpired
  );
  expect(await f.routing.deliver(envelope(ALPHA))).toEqual({
    reason: SUPERVISOR_ENDPOINT_REASONS.leaseExpired,
    status: "transient-failure",
  });
  // Released, with no mailbox: none. The r8 path is not taken back.
  f.leases.rows.set(ALPHA, { ...row, releasedAt: NOW.toISOString() });
  await expect(f.routing.assertReady(scope, ALPHA)).rejects.toThrow(
    SUPERVISOR_ENDPOINT_REASONS.noEndpoint
  );
  expect(f.legacyReady).toEqual([]);
  expect(f.legacyDelivered).toEqual([]);
  // A lease store outage is a readiness outage, never "unready".
  f.setLeaseDown(true);
  await expect(f.routing.assertReady(scope, ALPHA)).rejects.toBeInstanceOf(
    SupervisorMessageV2ReadinessUnavailableError
  );
  const outage = await f.routing.deliver(envelope(ALPHA));
  expect(outage.status).toBe("transient-failure");
  expect(JSON.stringify(outage)).not.toContain("driver text");
});

test("recipient routing hands every lease-routed recipient to T2's endpoint port when it is wired, and merges its not-enrolled spells", async () => {
  const f = routingFixture({ endpoint: true });
  await f.routing.assertReady(scope, BETA);
  expect(await f.routing.deliver(envelope(BETA))).toEqual({
    status: "accepted",
  });
  expect(f.endpointCalls).toEqual([`ready ${BETA}`, `deliver ${BETA}`]);
  // The r8 seat without a lease row still goes r8's way.
  await f.routing.assertReady(scope, ALPHA);
  expect(f.legacyReady).toEqual([ALPHA]);
  expect(f.routing.notEnrolledSince(ALPHA)).toBe(3);
  expect(f.routing.notEnrolledSince(BETA)).toBe(7);
  expect(f.routing.notEnrolledSince("supervisor:mailbox")).toBeUndefined();
});

/** The service factory with every store faked (no PostgreSQL, no Temporal). */
const fakeService = (input: {
  createHostFails?: boolean;
  leases?: ReturnType<typeof fakeLeaseStore>;
  mounted?: boolean;
  resolveLocator: SupervisorEndpointLocatorResolver;
}) => {
  const closes: string[] = [];
  const closable = (name: string) => ({
    close: () => {
      closes.push(name);
      return Promise.resolve();
    },
    migrate: () => Promise.resolve(),
  });
  const taskStore = Object.assign(
    new InMemoryTaskStore(),
    closable("task-store")
  );
  const service = createSupervisorA2AV2Service({
    allSupervisors: {
      authenticator,
      hasMailbox: () => false,
      legacySeats: [],
      mayReceive: () => true,
      principalForRecipient: principalFor,
      resolveLocator: input.resolveLocator,
      routePath: "/a2a/v2",
      sessionTtlMs: 60_000,
      supervisorIds: [ALPHA, BETA],
    },
    card: {
      description: "r9 fake service",
      supervisorId: ALPHA,
      url: "http://127.0.0.1:7321/a2a/v2",
    },
    databaseUrl: "postgres://loop:private-password@127.0.0.1:1/x",
    delivery: { deliver: () => Promise.resolve({ status: "accepted" }) },
    dependencies: {
      ...(input.leases
        ? {
            connectLeases: () =>
              Promise.resolve(
                Object.assign(
                  input.leases?.store as object,
                  closable("leases")
                ) as never
              ),
          }
        : {}),
      connectLedger: () =>
        Promise.resolve({
          ...closable("ledger"),
          // r9 integration: "not in this scope" is the ledger's typed
          // refusal; anything else is the ledger failing to answer.
          assertStartIntent: (workflowId: string) =>
            Promise.reject(
              workflowId === "supervisor-message:v2:down"
                ? new Error("connect ECONNREFUSED 127.0.0.1:5432")
                : new SupervisorMessageV2StartIntentScopeError("absent")
            ),
          deployment: "r9-queue",
        }) as never,
      connectSessions: () =>
        Promise.resolve({
          ...closable("sessions"),
          assertReady: () => Promise.resolve(),
          current: () => Promise.resolve(undefined),
        }) as never,
      connectTaskStore: () => Promise.resolve(taskStore as never),
      createHost: () =>
        input.createHostFails
          ? Promise.reject(new Error("host refused"))
          : Promise.resolve(closable("host") as never),
      createWorkflows: () =>
        new InMemoryWorkflowPort({
          definitions: [supervisorMessageV2WorkflowDefinition],
        }),
    },
    dispatchOwner: "v2-dispatcher:r9-test",
    host: { buildId: "r9-test", taskQueue: "r9-queue" } as never,
    now: () => NOW.toISOString(),
    policy: {
      claimTimeoutMs: 60_000,
      escalationTimeoutMs: 120_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 1000,
    },
    providerReadiness: { ready: () => ({}) as never },
    rebindAuthority: {
      decide: () => ({
        allowed: false,
        authorityRef: "authority:x",
        reasonCode: "x",
      }),
    },
    route: {
      authenticator: { authenticate: () => undefined },
      ...(input.mounted === undefined ? {} : { mounted: input.mounted }),
      pathname: "/a2a/v2",
      tenant: TENANT,
    },
    supervisorId: ALPHA,
  });
  return { closes, service };
};

test("the service mounts every supervisor's gated ingress, the session routes and message status under routePath; without an r8 recipient the bare route is not served", async () => {
  const home = serverHome();
  const leases = fakeLeaseStore(home.resolveLocator);
  const { closes, service: pending } = fakeService({
    leases,
    mounted: false,
    resolveLocator: home.resolveLocator,
  });
  const service = await pending;
  const route = service.allSupervisorsRoute;
  expect(route?.routePath).toBe("/a2a/v2");
  const handle = (request: Request) =>
    (route as NonNullable<typeof route>).httpHandler(request);
  // Sessions reach the lease store this service opened.
  const claimed = await handle(sessionRequest(claimBody()));
  expect(claimed.status).toBe(200);
  expect(leases.rows.get(ALPHA)?.epoch).toBe(1);
  // A configured supervisor's ingress reaches the SDK with the gate's
  // identity: a task read answers as JSON-RPC, not 401.
  const read = await handle(
    ingressRequest({
      id: 7,
      jsonrpc: "2.0",
      method: "GetTask",
      params: { id: "t-404" },
    })
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: 7, jsonrpc: "2.0" });
  // The gate refuses a forged sender before the SDK.
  expect((await handle(ingressRequest(sendMessage(BETA)))).status).toBe(403);
  // An unconfigured supervisor has no ingress.
  const unknown = await handle(
    new Request("http://127.0.0.1:7321/a2a/v2/supervisors/gamma", {
      body: "{}",
      headers: {
        authorization: "Bearer token-alpha",
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
  expect(unknown.status).toBe(404);
  // Message status: a message the ledger has not recorded in this scope.
  const status = await handle(
    new Request(
      "http://127.0.0.1:7321/a2a/v2/messages/supervisor-message%3Av2%3Ax",
      {
        headers: { authorization: "Bearer token-alpha" },
      }
    )
  );
  expect(status.status).toBe(404);
  // A ledger that cannot answer is an outage (503), never "no such message",
  // and its error text is not disclosed.
  const outage = await handle(
    new Request(
      "http://127.0.0.1:7321/a2a/v2/messages/supervisor-message%3Av2%3Adown",
      {
        headers: { authorization: "Bearer token-alpha" },
      }
    )
  );
  expect(outage.status).toBe(503);
  expect(await outage.json()).toEqual({ error: { code: "v2-unavailable" } });
  // No r8 recipient: the bare route is not served.
  expect(service.pathnames).toEqual([]);
  expect(
    (
      await service.httpHandler(
        new Request("http://127.0.0.1:7321/a2a/v2", { method: "POST" })
      )
    ).status
  ).toBe(404);
  await service.close();
  expect(closes).toEqual([
    "host",
    "leases",
    "sessions",
    "ledger",
    "task-store",
  ]);
});

test("the service answers 503 on the session routes when no lease store is wired, and closes an opened lease store when a later stage fails", async () => {
  const home = serverHome();
  const { service: pending } = fakeService({
    resolveLocator: home.resolveLocator,
  });
  const service = await pending;
  const response = await service.allSupervisorsRoute?.httpHandler(
    sessionRequest(claimBody())
  );
  expect(response?.status).toBe(503);
  // r8's bare route stays served when mounted is not false.
  expect(service.pathnames).toEqual(["/a2a/v2"]);
  await service.close();
  const leases = fakeLeaseStore(home.resolveLocator);
  const failing = fakeService({
    createHostFails: true,
    leases,
    resolveLocator: home.resolveLocator,
  });
  const failure = await failing.service.then(
    () => "unexpected",
    (error: unknown) => String(error)
  );
  expect(failure).toContain("initialization failed at runtime-host");
  expect(failure).not.toContain("private-password");
  expect(failing.closes).toContain("leases");
});

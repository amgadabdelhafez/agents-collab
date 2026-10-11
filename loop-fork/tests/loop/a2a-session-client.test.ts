import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import { serve } from "bun";
import {
  A2AClientError,
  a2aIngressFetch,
  a2aMessageStatus,
  acknowledgeA2AWorkflows,
  claimChannelA2AEndpoint,
  claimRunA2AEndpoint,
  readA2ALeaseRecord,
  releaseRecordedA2ALease,
  renewA2ASession,
  resolveA2AClientEndpoint,
  sendA2AMessage,
} from "../../src/loop/a2a-session-client";
import {
  A2A_SESSION_TOOLS,
  a2aBridgeSession,
  callA2ASessionTool,
  extractA2AAsFlag,
  runA2ACommand,
} from "../../src/loop/a2a-session-command";
import {
  agentCardFor,
  FROM_METADATA_KEY,
} from "../../src/loop/a2a-supervisor-adapter";
import { SupervisorA2AExecutor } from "../../src/loop/a2a-supervisor-executor";
import { createSupervisorA2AHttpHandler } from "../../src/loop/a2a-supervisor-http";
import { SupervisorA2ARequestHandler } from "../../src/loop/a2a-supervisor-request-handler";
import {
  A2A_V2_MESSAGE_STATUS_SCHEMA,
  A2A_V2_SESSION_RECEIPT_SCHEMA,
  matchA2AV2Route,
  parseA2AV2SessionRequest,
} from "../../src/loop/a2a-v2-routes-contract";
import {
  runMailboxCommand,
  runMailboxCommandWithV2Ack,
} from "../../src/loop/mailbox-command";
import { callRecipientRoute } from "../../src/loop/recipient-api-client";
import { readRunManifest, updateRunManifest } from "../../src/loop/run-state";
import { mailboxPathFor } from "../../src/loop/supervisor-mailbox-delivery";

const ROUTE = "/a2a/v2";
const ALICE = "supervisor:alice";
const BOB = "supervisor:bob";
const ALICE_TOKEN = "alice-test-fixture-token-1f2e3d";
const BOB_TOKEN = "bob-test-fixture-token-9a8b7c";
const REPO = "repo-abc123";
const RUN = "7";
const EXPIRES = "2026-10-11T02:00:00.000Z";
const V2_LEGACY = `supervisor-message-workflow:v2:${"a".repeat(64)}`;
const V2_DEPLOYMENT = `supervisor-message-workflow:v2:deployment:${"b".repeat(64)}`;
const V1 = `supervisor-message:${"c".repeat(64)}`;

interface Seen {
  authorization: string | null;
  body: unknown;
  method: string;
  path: string;
}

type Responder = (seen: Seen) => Response | Promise<Response> | undefined;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-t4-"));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};

/**
 * A disposable stand-in for T3's routes: it decodes session bodies with the
 * contract's own parser and answers with the contract's receipt, unless a
 * test responder answers first.
 */
const fakeServer = (responder?: Responder) => {
  const seen: Seen[] = [];
  const server = serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const entry: Seen = {
        authorization: request.headers.get("authorization"),
        body,
        method: request.method,
        path: url.pathname,
      };
      seen.push(entry);
      const custom = await responder?.(entry);
      if (custom) {
        return custom;
      }
      const match = matchA2AV2Route(ROUTE, url.pathname);
      if (match?.route === "session") {
        const parsed = parseA2AV2SessionRequest(match.operation, body);
        return Response.json({
          ...(match.operation === "release" ? { changed: true } : {}),
          descriptorRevision: 1,
          epoch: "epoch" in parsed ? parsed.epoch : 1,
          expiresAt: EXPIRES,
          holderRef: parsed.holderRef,
          kind: "locator" in parsed ? parsed.locator.kind : "loop-run",
          operation: match.operation,
          releasedAt:
            match.operation === "release" ? "2026-10-11T01:00:00.000Z" : null,
          schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
          supervisorId: parsed.supervisorId,
        });
      }
      if (url.pathname === `${ROUTE}/recipient`) {
        const command = body as { operation: string; workflowId: string };
        return Response.json({
          acknowledgedAt: null,
          claimedAt: null,
          phase: command.operation === "claim" ? "claimed" : "acknowledged",
          schema: "supervisor-message-recipient-receipt.v2",
          workflowId: command.workflowId,
          workResultCompleted: false,
        });
      }
      return Response.json({ error: { code: "not-found" } }, { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => {
    server.stop(true);
  });
  return { port: server.port as number, seen };
};

const harness = (responder?: Responder) => {
  const home = tempDir();
  const server = fakeServer(responder);
  const configPath = join(home, "orchestration.json");
  const config = {
    a2aV2: { routePath: ROUTE },
    hostname: "127.0.0.1",
    port: server.port,
    supervisors: [
      {
        principal: "principal:alice",
        supervisorId: ALICE,
        tokenEnv: "ALICE_TOKEN",
      },
      { principal: "principal:bob", supervisorId: BOB, tokenEnv: "BOB_TOKEN" },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // One token per session environment, as the runbook prescribes.
  const base = { HOME: home, LOOP_ORCHESTRATION_CONFIG: configPath };
  const env: NodeJS.ProcessEnv = { ...base, ALICE_TOKEN };
  const bobEnv: NodeJS.ProcessEnv = { ...base, BOB_TOKEN };
  const bothEnv: NodeJS.ProcessEnv = { ...base, ALICE_TOKEN, BOB_TOKEN };
  return { bobEnv, bothEnv, config, configPath, env, home, server };
};

const writeRun = (
  home: string,
  overrides: Record<string, unknown> = {}
): { manifestPath: string; runDir: string } => {
  const runDir = join(home, ".loop", "runs", REPO, RUN);
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      claudeSessionId: "11111111-2222-3333-4444-555555555555",
      codexRemoteUrl: "ws://127.0.0.1:4567",
      codexThreadId: "thread-xyz",
      createdAt: "2026-10-10T00:00:00.000Z",
      cwd: home,
      mode: "paired",
      ossSessionId: "",
      pid: 4242,
      primaryAgent: "claude",
      repoId: REPO,
      runId: RUN,
      state: "working",
      status: "running",
      updatedAt: "2026-10-10T00:00:00.000Z",
      ...overrides,
    })
  );
  return { manifestPath, runDir };
};

test("the endpoint comes from the orchestration config, loopback only, and never renders its token", () => {
  const h = harness();
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  expect(endpoint.baseUrl).toBe(`http://127.0.0.1:${h.server.port}`);
  expect(endpoint.routePath).toBe(ROUTE);
  for (const rendering of [
    JSON.stringify(endpoint),
    String(endpoint),
    inspect(endpoint, { depth: 5, showHidden: true }),
  ]) {
    expect(rendering).not.toContain(ALICE_TOKEN);
  }
  const withConfig = (patch: Record<string, unknown>) => {
    writeFileSync(h.configPath, JSON.stringify({ ...h.config, ...patch }));
    return () => resolveA2AClientEndpoint(ALICE, { env: h.env });
  };
  for (const hostname of [
    "0.0.0.0",
    "localhost",
    "example.com",
    "::ffff:127.0.0.1",
  ]) {
    expect(withConfig({ hostname })).toThrow("127.0.0.1 or ::1");
  }
  expect(withConfig({ hostname: "::1" })().baseUrl).toBe(
    `http://[::1]:${h.server.port}`
  );
  expect(withConfig({ a2aV2: undefined })).toThrow("not configured");
  expect(withConfig({ a2aV2: { routePath: "a2a" } })).toThrow("routePath");
  writeFileSync(h.configPath, JSON.stringify(h.config));
  expect(() =>
    resolveA2AClientEndpoint("supervisor:carol", { env: h.env })
  ).toThrow("not a configured supervisor");
  const missingToken = () =>
    resolveA2AClientEndpoint(ALICE, { env: { ...h.env, ALICE_TOKEN: "" } });
  expect(missingToken).toThrow("ALICE_TOKEN is not set");
  expect(() => resolveA2AClientEndpoint("alice", { env: h.env })).toThrow();
});

test("RA1: a configured origin passes the origin policy and the token goes only there", () => {
  const h = harness();
  const withConfig = (patch: Record<string, unknown>) => {
    writeFileSync(h.configPath, JSON.stringify({ ...h.config, ...patch }));
    return () => resolveA2AClientEndpoint(ALICE, { env: h.env });
  };
  // The configured origin wins over the listener, whatever it binds.
  const remote = withConfig({
    hostname: "0.0.0.0",
    origin: "https://loop.home.lab",
  })();
  expect(remote.baseUrl).toBe("https://loop.home.lab");
  expect(remote.url(`${ROUTE}/sessions/claim`)).toBe(
    `https://loop.home.lab${ROUTE}/sessions/claim`
  );
  expect(() => remote.url("//evil.example/a2a")).toThrow(
    "not on the configured server"
  );
  expect(
    withConfig({ origin: `http://127.0.0.1:${h.server.port}` })().baseUrl
  ).toBe(`http://127.0.0.1:${h.server.port}`);
  for (const origin of [
    "http://loop.home.lab",
    "http://localhost:7321",
    "https://user:pass@loop.home.lab",
    "https://loop.home.lab/prefix",
    "https://loop.home.lab?x=1",
  ]) {
    expect(withConfig({ origin })).toThrow("orchestration origin");
  }
  writeFileSync(h.configPath, JSON.stringify(h.config));
});

test("--a2a-as claims a run by ids only, after naming the supervisor in the manifest", async () => {
  const h = harness();
  const run = writeRun(h.home);
  const claimed = await claimRunA2AEndpoint(
    { manifestPath: run.manifestPath, runDir: run.runDir, supervisorId: ALICE },
    { env: h.env }
  );
  const [request] = h.server.seen;
  expect(request?.path).toBe(`${ROUTE}/sessions/claim`);
  expect(request?.authorization).toBe(`Bearer ${ALICE_TOKEN}`);
  // Ids only: no path, no URL, nothing the server would read or dial.
  expect(request?.body).toEqual({
    holderRef: `loop-run:${REPO}:${RUN}:claude`,
    locator: { kind: "loop-run", repoId: REPO, runId: RUN, seat: "claude" },
    schema: "supervisor-endpoint-session-claim.v2",
    sessionRef: "session:11111111-2222-3333-4444-555555555555",
    supervisorId: ALICE,
  });
  expect(JSON.stringify(request?.body)).not.toContain(h.home);
  expect(JSON.stringify(request?.body)).not.toContain("ws://");
  expect(claimed.receipt.epoch).toBe(1);
  // The manifest names the claimant, and keeps it across a rewrite.
  expect(readRunManifest(run.manifestPath)?.a2aSupervisorId).toBe(ALICE);
  updateRunManifest(run.manifestPath, (current) =>
    current ? { ...current, state: "stopped" } : undefined
  );
  expect(
    JSON.parse(readFileSync(run.manifestPath, "utf8")).a2aSupervisorId
  ).toBe(ALICE);
  const record = readA2ALeaseRecord(run.runDir);
  expect(record).toMatchObject({
    epoch: 1,
    holderRef: `loop-run:${REPO}:${RUN}:claude`,
    releasedAt: null,
    supervisorId: ALICE,
  });
  const recordPath = join(run.runDir, "a2a-lease.json");
  // biome-ignore lint/suspicious/noBitwiseOperators: file mode bits.
  expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(recordPath, "utf8")).not.toContain(ALICE_TOKEN);
});

test("the run manifest keeps only a supervisor id as a2aSupervisorId", () => {
  const home = tempDir();
  for (const value of ["supervisor:../x", "alice", 7, "supervisor:Alice"]) {
    const run = writeRun(home, { a2aSupervisorId: value });
    expect(readRunManifest(run.manifestPath)?.a2aSupervisorId).toBeUndefined();
  }
  const run = writeRun(home, { a2aSupervisorId: ALICE });
  expect(readRunManifest(run.manifestPath)?.a2aSupervisorId).toBe(ALICE);
});

test("a codex seat and a codex-thread claim name the thread, never the remote URL", async () => {
  const h = harness();
  const run = writeRun(h.home, { primaryAgent: "codex" });
  await claimRunA2AEndpoint(
    { manifestPath: run.manifestPath, runDir: run.runDir, supervisorId: ALICE },
    { env: h.env }
  );
  await claimRunA2AEndpoint(
    {
      kind: "codex-thread",
      manifestPath: run.manifestPath,
      runDir: run.runDir,
      supervisorId: ALICE,
    },
    { env: h.env, takeover: true, ttlMs: 60_000 }
  );
  expect(h.server.seen.map((entry) => entry.body)).toEqual([
    expect.objectContaining({
      locator: { kind: "loop-run", repoId: REPO, runId: RUN, seat: "codex" },
      sessionRef: "session:thread-xyz",
    }),
    {
      holderRef: `codex-thread:${REPO}:${RUN}`,
      locator: {
        kind: "codex-thread",
        repoId: REPO,
        runId: RUN,
        threadId: "thread-xyz",
      },
      schema: "supervisor-endpoint-session-claim.v2",
      sessionRef: "session:thread-xyz",
      supervisorId: ALICE,
      takeover: true,
      ttlMs: 60_000,
    },
  ]);
  for (const entry of h.server.seen) {
    expect(JSON.stringify(entry.body)).not.toContain("ws://");
  }
});

test("a claim is refused before any request without session ids, a seat or a well-formed run", async () => {
  const h = harness();
  const noSession = writeRun(h.home, { claudeSessionId: "" });
  await expect(
    claimRunA2AEndpoint(
      {
        manifestPath: noSession.manifestPath,
        runDir: noSession.runDir,
        supervisorId: ALICE,
      },
      { env: h.env }
    )
  ).rejects.toThrow("no claude session id");
  const oss = writeRun(h.home, { primaryAgent: "oss" });
  await expect(
    claimRunA2AEndpoint(
      {
        manifestPath: oss.manifestPath,
        runDir: oss.runDir,
        supervisorId: ALICE,
      },
      { env: h.env }
    )
  ).rejects.toThrow("pass --seat");
  await expect(
    claimRunA2AEndpoint(
      {
        manifestPath: join(h.home, "absent.json"),
        runDir: h.home,
        supervisorId: ALICE,
      },
      { env: h.env }
    )
  ).rejects.toThrow("manifest is unavailable");
  const traversal = writeRun(h.home, { runId: "../8" });
  await expect(
    claimRunA2AEndpoint(
      {
        manifestPath: traversal.manifestPath,
        runDir: traversal.runDir,
        supervisorId: ALICE,
      },
      { env: h.env }
    )
  ).rejects.toThrow();
  expect(h.server.seen).toEqual([]);
  expect(existsSync(join(noSession.runDir, "a2a-lease.json"))).toBe(false);
});

test("route refusals surface their contract code, never a token, and write no lease record", async () => {
  const current = {
    epoch: 4,
    expiresAt: EXPIRES,
    holderRef: "loop-run:other:9:claude",
    state: "live",
  };
  const responses: Response[] = [
    Response.json({ error: { code: "lease-held", current } }, { status: 409 }),
    Response.json({ error: { code: "locator-refused" } }, { status: 403 }),
    Response.json({ error: { code: "v2-unavailable" } }, { status: 503 }),
    new Response("upstream text with detail", { status: 502 }),
    // A redirect to a route that would answer with a valid receipt.
    new Response(null, { headers: { location: "/redirected" }, status: 307 }),
  ];
  const h = harness((seen) =>
    seen.path === "/redirected"
      ? Response.json({
          descriptorRevision: 1,
          epoch: 1,
          expiresAt: EXPIRES,
          holderRef: `loop-run:${REPO}:${RUN}:claude`,
          kind: "loop-run",
          operation: "claim",
          releasedAt: null,
          schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
          supervisorId: ALICE,
        })
      : responses.shift()
  );
  const run = writeRun(h.home);
  const attempt = async () => {
    try {
      await claimRunA2AEndpoint(
        {
          manifestPath: run.manifestPath,
          runDir: run.runDir,
          supervisorId: ALICE,
        },
        { env: h.env }
      );
    } catch (error) {
      return error as A2AClientError;
    }
    throw new Error("expected a refusal");
  };
  const held = await attempt();
  expect(held.code).toBe("lease-held");
  expect(held.detail).toEqual({ current });
  expect((await attempt()).code).toBe("locator-refused");
  expect((await attempt()).code).toBe("v2-unavailable");
  const opaque = await attempt();
  expect(opaque.code).toBe("unavailable");
  expect(opaque.message).not.toContain("upstream text");
  // A redirect is never followed.
  const redirected = await attempt();
  expect(redirected.code).toBe("unavailable");
  expect(h.server.seen.map((entry) => entry.path)).toEqual(
    new Array(5).fill(`${ROUTE}/sessions/claim`)
  );
  for (const error of [held, redirected]) {
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain(
      ALICE_TOKEN
    );
  }
  expect(existsSync(join(run.runDir, "a2a-lease.json"))).toBe(false);
});

test("the SDK's fetch reaches only the one ingress, with the token and no redirect", async () => {
  const h = harness();
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  const url = endpoint.url(`${ROUTE}/supervisors/bob`);
  const calls: { body: string; request: Request }[] = [];
  const fetchImpl = Object.assign(
    async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(target, init);
      calls.push({ body: await request.text(), request });
      return new Response("{}");
    },
    { preconnect: fetch.preconnect }
  );
  const ingress = a2aIngressFetch(endpoint, url, fetchImpl);
  await ingress(url, {
    body: "{}",
    headers: { authorization: "Bearer forged" },
    method: "POST",
  });
  // A Request resource keeps its method and body.
  await ingress(new Request(url, { body: "[1]", method: "POST" }));
  expect(calls.map((call) => [call.request.method, call.body])).toEqual([
    ["POST", "{}"],
    ["POST", "[1]"],
  ]);
  for (const { request } of calls) {
    expect(request.url).toBe(url);
    expect(request.headers.get("authorization")).toBe(`Bearer ${ALICE_TOKEN}`);
    expect(request.redirect).toBe("error");
  }
  for (const other of [
    endpoint.url(`${ROUTE}/supervisors/carol`),
    `${url}/extra`,
    "http://127.0.0.1:1/a2a/v2/supervisors/bob",
  ]) {
    await expect(ingress(other, { method: "POST" })).rejects.toThrow(
      "unexpected A2A request target"
    );
  }
  expect(calls).toHaveLength(2);
  await expect(
    callRecipientRoute({
      command: { operation: "claim", requestId: "r1", workflowId: V2_LEGACY },
      token: "",
      url: endpoint.url(`${ROUTE}/recipient`),
    })
  ).rejects.toThrow("token is not available");
  expect(h.server.seen).toEqual([]);
});

test("a receipt for another holder, supervisor or operation is not believed", async () => {
  const bodies = [
    { holderRef: "someone-else" },
    { supervisorId: BOB },
    { operation: "renew" },
    { epoch: 0 },
    { kind: "pigeon" },
  ];
  const h = harness((seen) => {
    const patch = bodies.shift();
    const request = seen.body as Record<string, unknown>;
    return patch
      ? Response.json({
          descriptorRevision: 1,
          epoch: 1,
          expiresAt: EXPIRES,
          holderRef: request.holderRef,
          kind: "loop-run",
          operation: "claim",
          releasedAt: null,
          schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
          supervisorId: request.supervisorId,
          ...patch,
        })
      : undefined;
  });
  const run = writeRun(h.home);
  for (let index = 0; index < 5; index++) {
    const error = await claimRunA2AEndpoint(
      {
        manifestPath: run.manifestPath,
        runDir: run.runDir,
        supervisorId: ALICE,
      },
      { env: h.env }
    ).catch((caught: unknown) => caught as A2AClientError);
    expect((error as A2AClientError).code).toBe("invalid-response");
  }
  expect(existsSync(join(run.runDir, "a2a-lease.json"))).toBe(false);
});

test("release presents the recorded fence once, is idempotent locally and never throws", async () => {
  let fenced = false;
  let down = false;
  const h = harness(() => {
    if (down) {
      return Response.json(
        { error: { code: "v2-unavailable" } },
        { status: 503 }
      );
    }
    return fenced
      ? Response.json(
          { error: { code: "lease-fenced", reason: "epoch-mismatch" } },
          { status: 409 }
        )
      : undefined;
  });
  const run = writeRun(h.home);
  expect(await releaseRecordedA2ALease(run.runDir, { env: h.env })).toEqual({
    outcome: "none",
  });
  await claimRunA2AEndpoint(
    { manifestPath: run.manifestPath, runDir: run.runDir, supervisorId: ALICE },
    { env: h.env }
  );
  down = true;
  const failed = await releaseRecordedA2ALease(run.runDir, { env: h.env });
  expect(failed).toMatchObject({ outcome: "failed", supervisorId: ALICE });
  expect(JSON.stringify(failed)).not.toContain(ALICE_TOKEN);
  down = false;
  expect(await releaseRecordedA2ALease(run.runDir, { env: h.env })).toEqual({
    changed: true,
    outcome: "released",
    supervisorId: ALICE,
  });
  expect(h.server.seen.at(-1)?.body).toEqual({
    epoch: 1,
    holderRef: `loop-run:${REPO}:${RUN}:claude`,
    schema: "supervisor-endpoint-session-release.v2",
    supervisorId: ALICE,
  });
  const requests = h.server.seen.length;
  expect(
    await releaseRecordedA2ALease(run.runDir, { env: h.env })
  ).toMatchObject({
    outcome: "already-released",
  });
  expect(h.server.seen.length).toBe(requests);
  // A newer claim fenced this holder: reported, not retried as success.
  await claimRunA2AEndpoint(
    { manifestPath: run.manifestPath, runDir: run.runDir, supervisorId: ALICE },
    { env: h.env }
  );
  fenced = true;
  expect(await releaseRecordedA2ALease(run.runDir, { env: h.env })).toEqual({
    outcome: "fenced",
    reason: "epoch-mismatch",
    supervisorId: ALICE,
  });
  // A config the client cannot use, or a corrupt record, is a failed outcome.
  expect(
    await releaseRecordedA2ALease(run.runDir, {
      env: { ...h.env, LOOP_ORCHESTRATION_CONFIG: join(h.home, "absent") },
    })
  ).toMatchObject({ outcome: "failed" });
  writeFileSync(join(run.runDir, "a2a-lease.json"), "{not json");
  expect(
    await releaseRecordedA2ALease(run.runDir, { env: h.env })
  ).toMatchObject({
    outcome: "failed",
  });
});

test("renew presents the fence and the optional ttl only", async () => {
  const h = harness();
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  const receipt = await renewA2ASession(endpoint, {
    epoch: 3,
    holderRef: "loop-run:x:1:claude",
    ttlMs: 5000,
  });
  expect(receipt.epoch).toBe(3);
  expect(h.server.seen[0]?.body).toEqual({
    epoch: 3,
    holderRef: "loop-run:x:1:claude",
    schema: "supervisor-endpoint-session-renew.v2",
    supervisorId: ALICE,
    ttlMs: 5000,
  });
  await expect(
    renewA2ASession(endpoint, { epoch: 0, holderRef: "x" })
  ).rejects.toThrow();
  expect(h.server.seen.length).toBe(1);
});

test("a channel session is claimed by its id under the caller's own sessions root", async () => {
  const h = harness();
  const claimed = await claimChannelA2AEndpoint(
    { sessionId: "desk-1", supervisorId: ALICE },
    { env: h.env }
  );
  expect(claimed.dir).toBe(
    join(h.home, ".loop", "sessions", "alice", "desk-1")
  );
  expect(h.server.seen[0]?.body).toEqual({
    holderRef: "claude-channel:desk-1",
    locator: { kind: "claude-channel", sessionId: "desk-1" },
    schema: "supervisor-endpoint-session-claim.v2",
    sessionRef: "session:desk-1",
    supervisorId: ALICE,
  });
  for (const sessionId of ["../bob/desk-1", "/abs", "..", "a/b", "a.b"]) {
    await expect(
      claimChannelA2AEndpoint(
        { sessionId, supervisorId: ALICE },
        { env: h.env }
      )
    ).rejects.toThrow();
  }
  expect(h.server.seen.length).toBe(1);
  // Refused before anything is created: no directory escapes the root.
  expect(readdirSync(join(h.home, ".loop", "sessions"))).toEqual(["alice"]);
  expect(readdirSync(join(h.home, ".loop", "sessions", "alice"))).toEqual([
    "desk-1",
  ]);
});

test("send goes through the SDK client to the recipient's own ingress as the authenticated sender", async () => {
  const routed: { from: unknown; principal: string; tenant: string }[] = [];
  const handlerFor = (recipient: string, refuse = false) => {
    const pathname = `${ROUTE}/supervisors/${recipient.slice("supervisor:".length)}`;
    const card = agentCardFor({
      description: "fake ingress",
      supervisorId: recipient,
      url: `http://127.0.0.1${pathname}`,
    });
    return createSupervisorA2AHttpHandler({
      authenticator: {
        authenticate: (request) =>
          request.headers.get("authorization") === `Bearer ${ALICE_TOKEN}`
            ? { principal: "principal:alice", supervisorId: ALICE }
            : undefined,
      },
      handler: new SupervisorA2ARequestHandler(
        card,
        new InMemoryTaskStore(),
        new SupervisorA2AExecutor({
          adapter: {
            sendMessage: (input: {
              message: { metadata?: Record<string, unknown> };
              principal: string;
              tenant: string;
            }) => {
              routed.push({
                from: input.message.metadata?.[FROM_METADATA_KEY],
                principal: input.principal,
                tenant: input.tenant,
              });
              if (refuse) {
                // The executor ends a refused turn as a FAILED task.
                return Promise.reject(new Error("policy refused"));
              }
              return Promise.resolve({
                scopeId: "scope:1",
                state: TaskState.TASK_STATE_SUBMITTED,
                taskId: V2_LEGACY,
              });
            },
          } as never,
          now: () => "2026-10-10T00:00:00.000Z",
        })
      ),
      pathname,
      tenant: "tenant:t4",
    });
  };
  const ingress: Record<string, ReturnType<typeof handlerFor>> = {
    [`${ROUTE}/supervisors/bob`]: handlerFor(BOB),
    [`${ROUTE}/supervisors/dave`]: handlerFor("supervisor:dave", true),
  };
  const h = harness((seen) =>
    ingress[seen.path]?.(
      new Request(`http://127.0.0.1${seen.path}`, {
        body: JSON.stringify(seen.body),
        headers: {
          authorization: seen.authorization ?? "",
          "content-type": "application/json",
        },
        method: seen.method,
      })
    )
  );
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  const receipt = await sendA2AMessage(endpoint, {
    body: "Please review the lease store.",
    messageId: "msg-1",
    to: BOB,
  });
  expect(receipt).toEqual({
    accepted: true,
    messageId: "msg-1",
    taskId: expect.any(String),
    taskState: "TASK_STATE_SUBMITTED",
    to: BOB,
    workflowId: V2_LEGACY,
    workResultCompleted: false,
  });
  expect(routed).toEqual([
    { from: ALICE, principal: "principal:alice", tenant: "tenant:t4" },
  ]);
  expect(h.server.seen.map((entry) => entry.path)).toEqual([
    `${ROUTE}/supervisors/bob`,
  ]);
  expect(JSON.stringify(receipt)).not.toContain(ALICE_TOKEN);
  // An ingress that does not exist (no such route) is a refusal, not a claim.
  await expect(
    sendA2AMessage(endpoint, {
      body: "hi",
      messageId: "msg-2",
      to: "supervisor:carol",
    })
  ).rejects.toThrow("nothing is claimed delivered");
  for (const bad of [
    { body: "hi", messageId: "msg 3", to: BOB },
    { body: "   ", messageId: "msg-3", to: BOB },
    { body: "hi", messageId: "msg-3", to: "bob" },
    { body: "hi", contextId: "../x", messageId: "msg-3", to: BOB },
  ]) {
    await expect(sendA2AMessage(endpoint, bad)).rejects.toThrow();
  }
  expect(h.server.seen.length).toBe(2);
  // r9 integration: a turn the server refused comes back as a FAILED task;
  // that is a refusal with the server's reason, never acceptance.
  const refused = await sendA2AMessage(endpoint, {
    body: "hi",
    messageId: "msg-4",
    to: "supervisor:dave",
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(A2AClientError);
  expect((refused as A2AClientError).message).toContain(
    "nothing is claimed delivered"
  );
  expect((refused as A2AClientError).detail).toEqual({
    reason: "policy refused",
  });
  expect(A2A_SESSION_TOOLS.map((tool) => tool.name)).toEqual([
    "a2a_enroll",
    "a2a_release",
    "a2a_send",
    "a2a_status",
  ]);
});

test("status keeps delivery, the read ACK and completion apart and believes completion only for COMPLETED", async () => {
  const statuses: Record<string, unknown>[] = [
    {
      acknowledgedAt: "2026-10-10T00:02:00.000Z",
      deliveredAt: "2026-10-10T00:01:00.000Z",
      phase: "acknowledged",
      taskState: "TASK_STATE_SUBMITTED",
      workResultCompleted: false,
    },
    {
      acknowledgedAt: "2026-10-10T00:02:00.000Z",
      deliveredAt: "2026-10-10T00:01:00.000Z",
      phase: "acknowledged",
      taskState: "TASK_STATE_COMPLETED",
      workResultCompleted: true,
    },
    // An ACK reported as completion is refused.
    {
      acknowledgedAt: "2026-10-10T00:02:00.000Z",
      deliveredAt: "2026-10-10T00:01:00.000Z",
      phase: "acknowledged",
      taskState: "TASK_STATE_SUBMITTED",
      workResultCompleted: true,
    },
    { phase: "routed", taskState: null, workResultCompleted: false },
  ];
  const h = harness((seen) => {
    if (!seen.path.startsWith(`${ROUTE}/messages/`)) {
      return undefined;
    }
    const next = statuses.shift();
    return next
      ? Response.json({
          acknowledgedAt: null,
          deliveredAt: null,
          messageId: decodeURIComponent(seen.path.split("/").at(-1) ?? ""),
          schema: A2A_V2_MESSAGE_STATUS_SCHEMA,
          to: BOB,
          ...next,
        })
      : Response.json({ error: { code: "not-found" } }, { status: 404 });
  });
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  expect(await a2aMessageStatus(endpoint, "msg:1")).toMatchObject({
    acknowledgedAt: "2026-10-10T00:02:00.000Z",
    deliveredAt: "2026-10-10T00:01:00.000Z",
    taskState: "TASK_STATE_SUBMITTED",
    workResultCompleted: false,
  });
  expect(h.server.seen[0]?.method).toBe("GET");
  expect(h.server.seen[0]?.path).toBe(`${ROUTE}/messages/msg%3A1`);
  expect((await a2aMessageStatus(endpoint, "msg:1")).workResultCompleted).toBe(
    true
  );
  await expect(a2aMessageStatus(endpoint, "msg:1")).rejects.toThrow(
    "invalid status"
  );
  expect((await a2aMessageStatus(endpoint, "msg:1")).deliveredAt).toBeNull();
  const absent = await a2aMessageStatus(endpoint, "msg:1").catch(
    (error: unknown) => error as A2AClientError
  );
  expect((absent as A2AClientError).code).toBe("not-found");
  const requests = h.server.seen.length;
  await expect(a2aMessageStatus(endpoint, "../x")).rejects.toThrow();
  expect(h.server.seen.length).toBe(requests);
});

test("ack claims then acknowledges each V2 workflow on the recipient route and never claims completion", async () => {
  let refuseAcknowledge = "";
  const h = harness((seen) => {
    const command = seen.body as { operation?: string; workflowId?: string };
    if (
      seen.path === `${ROUTE}/recipient` &&
      command.operation === "acknowledge" &&
      command.workflowId === refuseAcknowledge
    ) {
      return Response.json(
        { code: "lifecycle-command-refused" },
        { status: 409 }
      );
    }
    // A message this recipient claimed earlier: the claim is refused.
    if (command.operation === "claim" && command.workflowId === V2_DEPLOYMENT) {
      return Response.json(
        { code: "lifecycle-command-refused" },
        { status: 409 }
      );
    }
    return undefined;
  });
  const endpoint = resolveA2AClientEndpoint(BOB, { env: h.bobEnv });
  expect(
    await acknowledgeA2AWorkflows(endpoint, [V2_LEGACY, V2_DEPLOYMENT])
  ).toEqual({
    acknowledged: [
      { phase: "acknowledged", workflowId: V2_LEGACY },
      { phase: "acknowledged", workflowId: V2_DEPLOYMENT },
    ],
    refused: [],
    workResultCompleted: false,
  });
  expect(
    h.server.seen.map((entry) => [entry.authorization, entry.body])
  ).toEqual([
    [
      `Bearer ${BOB_TOKEN}`,
      {
        operation: "claim",
        requestId: `a2a-ack:claim:${V2_LEGACY}`,
        workflowId: V2_LEGACY,
      },
    ],
    [
      `Bearer ${BOB_TOKEN}`,
      {
        operation: "acknowledge",
        requestId: `a2a-ack:acknowledge:${V2_LEGACY}`,
        workflowId: V2_LEGACY,
      },
    ],
    [
      `Bearer ${BOB_TOKEN}`,
      {
        operation: "claim",
        requestId: `a2a-ack:claim:${V2_DEPLOYMENT}`,
        workflowId: V2_DEPLOYMENT,
      },
    ],
    [
      `Bearer ${BOB_TOKEN}`,
      {
        operation: "acknowledge",
        requestId: `a2a-ack:acknowledge:${V2_DEPLOYMENT}`,
        workflowId: V2_DEPLOYMENT,
      },
    ],
  ]);
  refuseAcknowledge = V2_LEGACY;
  const partial = await acknowledgeA2AWorkflows(endpoint, [V2_LEGACY, V1]);
  expect(partial.acknowledged).toEqual([]);
  expect(partial.refused.map((entry) => entry.workflowId)).toEqual([
    V2_LEGACY,
    V1,
  ]);
  // The V1 id never reached the route.
  expect(
    h.server.seen.filter((entry) => JSON.stringify(entry.body).includes(V1))
  ).toEqual([]);
  await expect(
    runA2ACommand(["a2a", "ack", "--as", BOB, "--workflow", V2_LEGACY], {
      env: h.bobEnv,
    })
  ).rejects.toThrow(`ack refused for ${V2_LEGACY}`);
  refuseAcknowledge = "";
  expect(
    await runA2ACommand(["a2a", "ack", "--as", BOB, "--workflow", V2_LEGACY], {
      env: h.bobEnv,
    })
  ).toEqual({
    acknowledged: [{ phase: "acknowledged", workflowId: V2_LEGACY }],
    action: "ack",
    refused: [],
    workResultCompleted: false,
  });
});

const envelope = (workflowId: string, key: string) => ({
  artifactRefs: [],
  at: "2026-10-10T00:00:00.000Z",
  body: `body of ${key}`,
  delivery: "mailbox",
  idempotencyKey: key,
  messageId: key,
  target: BOB,
  threadId: key,
  workflowId,
});

test("mailbox ack acknowledges V2 envelopes on the recipient route first and leaves a refused one unread", async () => {
  const root = tempDir();
  const mailbox = mailboxPathFor(root, BOB);
  writeFileSync(
    mailbox,
    [
      envelope(V1, `${V1}:delivery:1`),
      envelope(V2_LEGACY, "v2-legacy-key"),
      envelope(V2_DEPLOYMENT, "v2-deployment-key"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
  );
  const calls: string[][] = [];
  const base = ["mailbox", "ack", "--id", BOB, "--root", root];
  const keys = [
    "--key",
    `${V1}:delivery:1`,
    "--key",
    "v2-legacy-key",
    "--key",
    "v2-deployment-key",
  ];
  // Every plain refusal happens before any route call.
  await expect(
    runMailboxCommandWithV2Ack([...base, ...keys, "--key", "unknown"], {
      acknowledgeV2: (_id, ids) => {
        calls.push([...ids]);
        return Promise.resolve({
          acknowledged: [],
          refused: [],
          workResultCompleted: false,
        });
      },
    })
  ).rejects.toThrow("unknown not in");
  await expect(
    runMailboxCommandWithV2Ack(
      [...base, ...keys, "--receipt", "0".repeat(32)],
      {
        acknowledgeV2: (_id, ids) => {
          calls.push([...ids]);
          return Promise.resolve({
            acknowledged: [],
            refused: [],
            workResultCompleted: false,
          });
        },
      }
    )
  ).rejects.toThrow("do not match the receipt");
  expect(calls).toEqual([]);
  const result = await runMailboxCommandWithV2Ack([...base, ...keys], {
    acknowledgeV2: (id, ids) => {
      calls.push([id, ...ids]);
      return Promise.resolve({
        acknowledged: [{ phase: "acknowledged", workflowId: V2_LEGACY }],
        refused: [{ reason: "refused", workflowId: V2_DEPLOYMENT }],
        workResultCompleted: false,
      });
    },
  });
  // Only V2 workflows go to the route; the V1 key is the cursor's alone.
  expect(calls).toEqual([[BOB, V2_LEGACY, V2_DEPLOYMENT]]);
  expect(result.consumedKeys).toEqual([`${V1}:delivery:1`, "v2-legacy-key"]);
  expect(result.heldKeys).toEqual(["v2-deployment-key"]);
  expect(result.v2?.workResultCompleted).toBe(false);
  const unread = runMailboxCommand([
    "mailbox",
    "receive",
    "--id",
    BOB,
    "--root",
    root,
  ]);
  expect(
    (unread.messages as { idempotencyKey: string }[]).map(
      (entry) => entry.idempotencyKey
    )
  ).toEqual(["v2-deployment-key"]);
  // A route that cannot be reached at all holds every V2 key.
  const outage = await runMailboxCommandWithV2Ack(
    [...base, "--key", "v2-deployment-key"],
    { acknowledgeV2: () => Promise.reject(new Error("server down")) }
  );
  expect(outage.consumed).toBe(0);
  expect(outage.heldKeys).toEqual(["v2-deployment-key"]);
  expect(outage.v2?.refused).toEqual([
    { reason: "server down", workflowId: V2_DEPLOYMENT },
  ]);
  // An already-consumed V2 key is not re-acknowledged; a V1-only ack never calls.
  const replay = await runMailboxCommandWithV2Ack(
    [...base, "--key", "v2-legacy-key"],
    {
      acknowledgeV2: (_id, ids) => {
        calls.push([...ids]);
        return Promise.resolve({
          acknowledged: [],
          refused: [],
          workResultCompleted: false,
        });
      },
    }
  );
  expect(replay.v2).toBeUndefined();
  expect(calls.length).toBe(1);
});

test("loop a2a parses strictly and acts only as the configured supervisor", async () => {
  const h = harness();
  const bodyFile = join(h.home, "body.txt");
  writeFileSync(bodyFile, "hello");
  for (const argv of [
    ["a2a"],
    ["a2a", "dance", "--as", ALICE],
    ["a2a", "send", "--to", BOB, "--body-file", bodyFile],
    [
      "a2a",
      "send",
      "--as",
      ALICE,
      "--to",
      BOB,
      "--body-file",
      bodyFile,
      "--server",
      "http://evil",
    ],
    ["a2a", "status", "--as", ALICE, "--message-id"],
    ["a2a", "status", "--as", ALICE, "--as", BOB, "--message-id", "m"],
    [
      "a2a",
      "enroll",
      "--as",
      ALICE,
      "--kind",
      "loop-run",
      "--session",
      "s1",
      "--run",
      RUN,
    ],
    [
      "a2a",
      "enroll",
      "--as",
      ALICE,
      "--kind",
      "claude-channel",
      "--run",
      RUN,
      "--session",
      "s1",
    ],
    ["a2a", "enroll", "--as", ALICE, "--kind", "pigeon", "--session", "s1"],
    [
      "a2a",
      "enroll",
      "--as",
      ALICE,
      "--kind",
      "codex-thread",
      "--run",
      RUN,
      "--seat",
      "claude",
    ],
    ["a2a", "release", "--as", ALICE],
    ["a2a", "release", "--as", ALICE, "--run", RUN, "--session", "s1"],
    ["a2a", "ack", "--as", "alice", "--workflow", V2_LEGACY],
  ]) {
    await expect(runA2ACommand(argv, { env: h.env })).rejects.toThrow();
  }
  expect(h.server.seen).toEqual([]);
  const run = writeRun(h.home);
  const enrolled = await runA2ACommand(
    [
      "a2a",
      "enroll",
      "--as",
      ALICE,
      "--kind",
      "loop-run",
      "--run",
      RUN,
      "--ttl-ms",
      "30000",
    ],
    {
      env: h.env,
      resolveRunStorage: (runId) => ({
        manifestPath: run.manifestPath,
        repoId: REPO,
        runDir: run.runDir,
        runId,
        storageRoot: join(h.home, ".loop", "runs"),
        transcriptPath: join(run.runDir, "transcript.jsonl"),
      }),
    }
  );
  expect(enrolled).toMatchObject({ action: "enroll", leaseRecord: run.runDir });
  expect(h.server.seen[0]?.body).toMatchObject({ ttlMs: 30_000 });
  // Bob cannot release the run Alice enrolled: refused before any request
  // (the release would otherwise go out with Alice's token).
  const sent = h.server.seen.length;
  await expect(
    runA2ACommand(["a2a", "release", "--as", BOB, "--run", RUN], {
      env: h.bobEnv,
      resolveRunStorage: (runId) => ({
        manifestPath: run.manifestPath,
        repoId: REPO,
        runDir: run.runDir,
        runId,
        storageRoot: join(h.home, ".loop", "runs"),
        transcriptPath: join(run.runDir, "transcript.jsonl"),
      }),
    })
  ).rejects.toThrow(`belongs to ${ALICE}`);
  expect(h.server.seen.length).toBe(sent);
  expect(readA2ALeaseRecord(run.runDir)?.releasedAt).toBeNull();
  const channel = await runA2ACommand(
    [
      "a2a",
      "enroll",
      "--as",
      ALICE,
      "--kind",
      "claude-channel",
      "--session",
      "s1",
      "--takeover",
    ],
    { env: h.env }
  );
  expect(channel.channelServer).toMatchObject({
    args: [
      "__bridge-mcp",
      join(h.home, ".loop", "sessions", "alice", "s1"),
      "claude",
    ],
  });
  expect(h.server.seen[1]?.body).toMatchObject({ takeover: true });
  // Bob cannot release Alice's session lease through his own id.
  await expect(
    runA2ACommand(["a2a", "release", "--as", BOB, "--session", "s1"], {
      env: h.bobEnv,
    })
  ).rejects.toThrow("no A2A lease");
  expect(
    await runA2ACommand(["a2a", "release", "--as", ALICE, "--session", "s1"], {
      env: h.env,
    })
  ).toMatchObject({ action: "release", outcome: "released" });
});

test("--a2a-as is taken out of the launch argv and must name a supervisor", () => {
  expect(extractA2AAsFlag(["--tmux", "--a2a-as", ALICE, "task.md"])).toEqual({
    argv: ["--tmux", "task.md"],
    supervisorId: ALICE,
  });
  expect(extractA2AAsFlag(["--a2a-as=supervisor:bob"])).toEqual({
    argv: [],
    supervisorId: BOB,
  });
  expect(extractA2AAsFlag(["--tmux"])).toEqual({ argv: ["--tmux"] });
  for (const argv of [
    ["--a2a-as"],
    ["--a2a-as", "bob"],
    ["--a2a-as", "supervisor:../x"],
    ["--a2a-as=", "--tmux"],
    ["--a2a-as", ALICE, "--a2a-as", BOB],
  ]) {
    expect(() => extractA2AAsFlag(argv)).toThrow("--a2a-as");
  }
});

test("bridge session mode is a claude bridge in <home>/.loop/sessions/<slug>/<id> with no run manifest", async () => {
  const h = harness();
  const sessionDir = join(h.home, ".loop", "sessions", "alice", "desk-1");
  mkdirSync(sessionDir, { recursive: true });
  expect(a2aBridgeSession(sessionDir, "claude", h.env)).toEqual({
    sessionDir,
    sessionId: "desk-1",
    supervisorId: ALICE,
  });
  expect(a2aBridgeSession(sessionDir, "codex", h.env)).toBeUndefined();
  for (const dir of [
    join(h.home, ".loop", "sessions", "alice"),
    join(h.home, ".loop", "sessions", "alice", "desk-1", "nested"),
    join(h.home, ".loop", "sessions", "Alice", "desk-1"),
    join(h.home, ".loop", "sessions", "alice", "desk.1"),
    join(h.home, ".loop", "runs", REPO, RUN),
    join(h.home, "elsewhere", "alice", "desk-1"),
  ]) {
    expect(a2aBridgeSession(dir, "claude", h.env)).toBeUndefined();
  }
  writeFileSync(join(sessionDir, "manifest.json"), "{}");
  expect(a2aBridgeSession(sessionDir, "claude", h.env)).toBeUndefined();
  rmSync(join(sessionDir, "manifest.json"));
  const session = a2aBridgeSession(sessionDir, "claude", h.env);
  if (!session) {
    throw new Error("expected session mode");
  }
  await expect(
    callA2ASessionTool("a2a_enroll", { path: "/etc" }, session, { env: h.env })
  ).rejects.toThrow("unexpected tool arguments");
  await expect(
    callA2ASessionTool("a2a_enroll", { takeover: "yes" }, session, {
      env: h.env,
    })
  ).rejects.toThrow("fixed by this session");
  expect(h.server.seen).toEqual([]);
  const enrolled = await callA2ASessionTool(
    "a2a_enroll",
    { provider_session: "claude-uuid-1", ttl_ms: 60_000 },
    session,
    { env: h.env }
  );
  expect(enrolled).toMatchObject({
    receipt: { epoch: 1, kind: "claude-channel" },
  });
  expect(h.server.seen[0]?.body).toEqual({
    holderRef: "claude-channel:desk-1",
    locator: { kind: "claude-channel", sessionId: "desk-1" },
    schema: "supervisor-endpoint-session-claim.v2",
    sessionRef: "session:claude-uuid-1",
    supervisorId: ALICE,
    ttlMs: 60_000,
  });
  expect(
    await callA2ASessionTool("a2a_release", {}, session, { env: h.env })
  ).toMatchObject({ outcome: "released" });
  await expect(
    callA2ASessionTool("a2a_status", { message_id: "m1", extra: 1 }, session, {
      env: h.env,
    })
  ).rejects.toThrow("unexpected tool arguments");
  await expect(
    callA2ASessionTool("a2a_shell", {}, session, { env: h.env })
  ).rejects.toThrow("Unknown tool");
});

/* ---------------------------------------------------------------------------
 * fix9 client identity: one fixed identity per session, one token per
 * environment, a trusted config, and a token that never leaves its origin.
 * ------------------------------------------------------------------------- */

const IDENTITY_FIELD_RE =
  /^(?:acting[_-]?as|as|from|identity|impersonate|on[_-]?behalf[_-]?of|principal|sender|supervisor(?:[_-]?id)?|takeover|token(?:[_-]?env)?)$/i;

const aliceSession = (h: ReturnType<typeof harness>) => {
  const sessionDir = join(h.home, ".loop", "sessions", "alice", "desk-1");
  mkdirSync(sessionDir, { recursive: true });
  const session = a2aBridgeSession(sessionDir, "claude", h.env);
  if (!session) {
    throw new Error("expected session mode");
  }
  return session;
};

test("an MCP tool call cannot choose another identity, a token or a takeover", async () => {
  const h = harness();
  // No tool schema offers an identity, token or takeover field.
  for (const tool of A2A_SESSION_TOOLS) {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const field of Object.keys(tool.inputSchema.properties)) {
      expect(IDENTITY_FIELD_RE.test(field)).toBe(false);
    }
  }
  const session = aliceSession(h);
  // The session's identity is fixed once it is resolved.
  expect(Object.isFrozen(session)).toBe(true);
  expect(() => {
    (session as { supervisorId: string }).supervisorId = BOB;
  }).toThrow();
  expect(session.supervisorId).toBe(ALICE);
  const attempts: [string, Record<string, unknown>][] = [
    ["a2a_enroll", { takeover: true }],
    ["a2a_enroll", { supervisor_id: BOB }],
    ["a2a_enroll", { as: BOB, ttl_ms: 60_000 }],
    ["a2a_release", { supervisorId: BOB }],
    ["a2a_send", { from: BOB, message: "hi", to: BOB }],
    ["a2a_send", { message: "hi", on_behalf_of: BOB, to: BOB }],
    ["a2a_send", { message: "hi", to: BOB, token_env: "BOB_TOKEN" }],
    ["a2a_status", { identity: BOB, message_id: "m1" }],
  ];
  for (const [name, args] of attempts) {
    await expect(
      callA2ASessionTool(name, args, session, { env: h.env })
    ).rejects.toThrow("fixed by this session");
  }
  expect(h.server.seen).toEqual([]);
  // The enroll a model can make never asks for a takeover.
  await callA2ASessionTool("a2a_enroll", {}, session, { env: h.env });
  expect(h.server.seen[0]?.body).toMatchObject({ supervisorId: ALICE });
  expect(h.server.seen[0]?.body).not.toHaveProperty("takeover");
  // A send goes out as the fixed identity, with its own token only (the fake
  // server has no ingress, so the send itself is refused afterwards).
  await expect(
    callA2ASessionTool(
      "a2a_send",
      { message: "hi", message_id: "m-fixed", to: BOB },
      session,
      { env: h.env }
    )
  ).rejects.toThrow("nothing is claimed delivered");
  const sent = h.server.seen.find((entry) =>
    entry.path.endsWith("/supervisors/bob")
  );
  expect(sent?.authorization).toBe(`Bearer ${ALICE_TOKEN}`);
  expect(JSON.stringify(sent?.body)).toContain(
    `"${FROM_METADATA_KEY}":"${ALICE}"`
  );
});

test("a multi-token environment is refused unless --allow-multi-token-env, naming variables only", async () => {
  const h = harness();
  let refusal = "";
  try {
    resolveA2AClientEndpoint(ALICE, { env: h.bothEnv });
  } catch (error) {
    refusal = (error as Error).message;
  }
  expect(refusal).toContain("BOB_TOKEN");
  expect(refusal).toContain("--allow-multi-token-env");
  expect(refusal).not.toContain(BOB_TOKEN);
  expect(refusal).not.toContain(ALICE_TOKEN);
  // An empty variable exposes no token.
  expect(
    resolveA2AClientEndpoint(ALICE, { env: { ...h.bothEnv, BOB_TOKEN: "" } })
      .supervisorId
  ).toBe(ALICE);
  expect(
    resolveA2AClientEndpoint(ALICE, {
      allowMultiTokenEnv: true,
      env: h.bothEnv,
    }).authorization()
  ).toBe(`Bearer ${ALICE_TOKEN}`);
  // CLI: refused before any request; only the human flag opts in, and then
  // only --as's own token is sent.
  const status = ["a2a", "status", "--as", ALICE, "--message-id", "m1"];
  await expect(runA2ACommand(status, { env: h.bothEnv })).rejects.toThrow(
    "BOB_TOKEN"
  );
  await expect(
    runA2ACommand(status, { allowMultiTokenEnv: true, env: h.bothEnv })
  ).rejects.toThrow("BOB_TOKEN");
  expect(h.server.seen).toEqual([]);
  await expect(
    runA2ACommand([...status, "--allow-multi-token-env"], { env: h.bothEnv })
  ).rejects.toThrow("not-found");
  expect(h.server.seen.map((entry) => entry.authorization)).toEqual([
    `Bearer ${ALICE_TOKEN}`,
  ]);
  // A bridge tool never acts from a multi-token environment.
  await expect(
    callA2ASessionTool("a2a_status", { message_id: "m1" }, aliceSession(h), {
      allowMultiTokenEnv: true,
      env: h.bothEnv,
    })
  ).rejects.toThrow("BOB_TOKEN");
  expect(h.server.seen.length).toBe(1);
});

test("a hostile LOOP_ORCHESTRATION_CONFIG is refused before any token is read", () => {
  const h = harness();
  const resolveWith = (path: string, uid?: () => number) => () =>
    resolveA2AClientEndpoint(ALICE, {
      env: { ...h.env, LOOP_ORCHESTRATION_CONFIG: path },
      ...(uid ? { uid } : {}),
    });
  expect(resolveWith(h.configPath)().supervisorId).toBe(ALICE);
  for (const mode of [0o666, 0o646, 0o620, 0o602]) {
    chmodSync(h.configPath, mode);
    expect(resolveWith(h.configPath)).toThrow("group- or world-writable");
  }
  chmodSync(h.configPath, 0o644);
  expect(resolveWith(h.configPath)().supervisorId).toBe(ALICE);
  const myUid = process.getuid?.() ?? 0;
  expect(resolveWith(h.configPath, () => myUid + 1)).toThrow(
    "not owned by the current user"
  );
  // A symlink is judged by the file it names.
  const link = join(h.home, "link.json");
  symlinkSync(h.configPath, link);
  expect(resolveWith(link)().supervisorId).toBe(ALICE);
  chmodSync(h.configPath, 0o666);
  expect(resolveWith(link)).toThrow("group- or world-writable");
  chmodSync(h.configPath, 0o600);
  expect(resolveWith(h.home)).toThrow("not a regular file");
  expect(resolveWith(join(h.home, "absent.json"))).toThrow("unavailable");
  expect(h.server.seen).toEqual([]);
});

test("the token never leaves the configured origin", async () => {
  const h = harness();
  const endpoint = resolveA2AClientEndpoint(ALICE, { env: h.env });
  expect(endpoint.url(`${ROUTE}/x`)).toBe(
    `http://127.0.0.1:${h.server.port}${ROUTE}/x`
  );
  for (const path of [
    "//evil.example/a2a",
    "@evil.example/a2a",
    "evil.example/a2a",
    "/\\evil.example/a2a",
    "/a2a\n/x",
    "/a2a x",
    "",
  ]) {
    expect(() => endpoint.url(path)).toThrow("not on the configured server");
  }
  // Ids from input stay ids: a recipient or message id that names a host is
  // refused before any request.
  for (const to of ["supervisor:bob@evil.example", "http://evil.example"]) {
    await expect(
      sendA2AMessage(endpoint, { body: "hi", messageId: "m-1", to })
    ).rejects.toThrow();
  }
  await expect(
    a2aMessageStatus(endpoint, "//evil.example/x")
  ).rejects.toThrow();
  expect(h.server.seen).toEqual([]);
});

test("a run enrolled as another supervisor is renamed only by an explicit takeover", async () => {
  const h = harness();
  const run = writeRun(h.home, { a2aSupervisorId: BOB });
  const input = {
    manifestPath: run.manifestPath,
    runDir: run.runDir,
    supervisorId: ALICE,
  };
  await expect(claimRunA2AEndpoint(input, { env: h.env })).rejects.toThrow(
    `enrolled as ${BOB}`
  );
  expect(readRunManifest(run.manifestPath)?.a2aSupervisorId).toBe(BOB);
  expect(h.server.seen).toEqual([]);
  // An explicit takeover renames; the same supervisor then re-enrolls freely.
  const claimed = await claimRunA2AEndpoint(input, {
    env: h.env,
    takeover: true,
  });
  expect(claimed.record.supervisorId).toBe(ALICE);
  expect(readRunManifest(run.manifestPath)?.a2aSupervisorId).toBe(ALICE);
  await claimRunA2AEndpoint(input, { env: h.env });
  expect(h.server.seen.length).toBe(2);
});

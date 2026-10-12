// ra1: `loop connect`, the MCP server that holds a supervisor's inbox stream.
// The stream route and the client are the production ones over a loopback
// listener; the inbox is in memory and the claim, release and recipient
// routes are minimal fakes that record what reached them.

import { afterEach, describe, expect, test } from "bun:test";
import { serve, sleep } from "bun";
import { A2AClientEndpoint } from "../../src/loop/a2a-session-client";
import {
  A2A_V2_SESSION_RECEIPT_SCHEMA,
  matchA2AV2Route,
  parseA2AV2SessionRequest,
} from "../../src/loop/a2a-v2-routes-contract";
import {
  CONNECT_TOOLS,
  codexThreadDeliverer,
  connectLocator,
  parseConnectArgs,
  runConnectCommand,
} from "../../src/loop/connect-command";
import type { SupervisorEndpointLeaseV2 } from "../../src/loop/supervisor-endpoint-lease";
import {
  createSupervisorInboxStreamHandler,
  type SupervisorInboxEntry,
  type SupervisorInboxStore,
  SupervisorInboxStreamHub,
} from "../../src/loop/supervisor-inbox-stream";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
} from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";

const fixture = supervisorMessageV2ReplayFixtures[0];
if (!fixture) {
  throw new Error("missing V2 fixture");
}
const SENDER = fixture.expectedScope;
const TENANT = SENDER.tenantId;
const RECIPIENT = "supervisor:phone";
const PRINCIPAL = "principal:phone";
const TOKEN = "token-phone";
const ROUTE = "/a2a/v2";

/** In-memory inbox with the store's contract: one row per workflow. */
class MemoryInbox implements SupervisorInboxStore {
  readonly entries: SupervisorInboxEntry[] = [];
  append(envelope: SupervisorMessageV2DeliveryEnvelope) {
    const existing = this.entries.find(
      (entry) => entry.envelope.workflowId === envelope.workflowId
    );
    if (existing) {
      return Promise.resolve({
        seq: existing.seq,
        status: "duplicate" as const,
      });
    }
    const seq = this.entries.length + 1;
    this.entries.push({
      appendedAt: new Date(1_760_000_000_000 + seq).toISOString(),
      envelope,
      seq,
    });
    return Promise.resolve({ seq, status: "appended" as const });
  }
  close() {
    return Promise.resolve();
  }
  read(input: {
    after: number;
    limit: number;
    recipient: string;
    tenantId: string;
  }) {
    return Promise.resolve(
      this.entries
        .filter(
          (entry) =>
            entry.seq > input.after &&
            entry.envelope.target === input.recipient &&
            entry.envelope.tenantId === input.tenantId
        )
        .slice(0, input.limit)
    );
  }
}

const envelopeFor = (key: string): SupervisorMessageV2DeliveryEnvelope => {
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    SENDER,
    key,
    "connect-test"
  );
  const deliveryId = deriveSupervisorMessageV2DeliveryId(SENDER, workflowId, 1);
  return {
    artifactRefs: [],
    body: `please review ${key}`,
    deliveryAttempt: 1,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: `message-${key}`,
    principal: SENDER.principal,
    schema: "supervisor-message-delivery.v2",
    target: RECIPIENT,
    tenantId: TENANT,
    threadId: `thread-${key}`,
    workflowId,
  };
};

/** An async iterable of stdin lines the test feeds and ends. */
class Lines implements AsyncIterable<string> {
  readonly #queue: string[] = [];
  #ended = false;
  #wake: (() => void) | undefined;
  push(value: unknown): void {
    this.#queue.push(`${JSON.stringify(value)}\n`);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const fakeServer = () => {
  const inbox = new MemoryInbox();
  const hub = new SupervisorInboxStreamHub();
  hub.attach(inbox);
  const state: {
    acks: { authorization: string | null; body: unknown }[];
    lease: SupervisorEndpointLeaseV2 | undefined;
    releases: unknown[];
  } = { acks: [], lease: undefined, releases: [] };
  const authenticator = {
    authenticate: (request: Request) =>
      request.headers.get("authorization") === `Bearer ${TOKEN}`
        ? { principal: PRINCIPAL, supervisorId: RECIPIENT }
        : undefined,
  };
  const stream = createSupervisorInboxStreamHandler({
    authenticator,
    hub,
    leases: () => ({
      resolve: () =>
        Promise.resolve(
          state.lease
            ? { lease: state.lease, state: "live" as const }
            : { state: "none" as const }
        ),
    }),
    limits: { heartbeatMs: 60_000, retryMs: 10 },
    principalForRecipient: (id) => (id === RECIPIENT ? PRINCIPAL : undefined),
    tenant: TENANT,
  });
  const receipt = (operation: string, lease: SupervisorEndpointLeaseV2) =>
    Response.json({
      descriptorRevision: lease.descriptorRevision,
      epoch: lease.epoch,
      expiresAt: lease.expiresAt,
      holderRef: lease.holderRef,
      kind: lease.kind,
      operation,
      releasedAt: lease.releasedAt,
      schema: A2A_V2_SESSION_RECEIPT_SCHEMA,
      supervisorId: lease.recipient,
    });
  const server = serve({
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (!authenticator.authenticate(request)) {
        return Response.json(
          { error: { code: "unauthenticated" } },
          { status: 401 }
        );
      }
      if (pathname === `${ROUTE}/recipient`) {
        const body = (await request.json()) as { workflowId: string };
        state.acks.push({
          authorization: request.headers.get("authorization"),
          body,
        });
        return Response.json({
          phase: "acknowledged",
          schema: "supervisor-message-recipient-receipt.v2",
          workflowId: body.workflowId,
          workResultCompleted: false,
        });
      }
      const match = matchA2AV2Route(ROUTE, pathname);
      if (match?.route === "session-inbox") {
        return stream(request, match.supervisorId);
      }
      if (match?.route === "session" && match.operation === "claim") {
        const body = parseA2AV2SessionRequest("claim", await request.json());
        state.lease = {
          descriptorId: "descriptor:phone",
          descriptorRevision: 1,
          epoch: (state.lease?.epoch ?? 0) + 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          holderRef: body.holderRef,
          kind: body.locator.kind,
          locator: body.locator,
          principal: PRINCIPAL,
          recipient: body.supervisorId,
          releasedAt: null,
          schema: "supervisor-endpoint-lease.v2",
          tenantId: TENANT,
        };
        expect(body.sessionRef).toBe("session:claude-session-1");
        return receipt("claim", state.lease);
      }
      if (match?.route === "session" && match.operation === "release") {
        const body = parseA2AV2SessionRequest("release", await request.json());
        state.releases.push(body);
        if (!state.lease) {
          return new Response(null, { status: 409 });
        }
        state.lease = {
          ...state.lease,
          releasedAt: "2026-10-11T00:00:00.000Z",
        };
        return receipt("release", state.lease);
      }
      return new Response(null, { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return {
    endpoint: new A2AClientEndpoint({
      baseUrl: `http://127.0.0.1:${server.port}`,
      routePath: ROUTE,
      supervisorId: RECIPIENT,
      token: TOKEN,
    }),
    hub,
    state,
  };
};

const until = async (predicate: () => boolean, what: string) => {
  for (let index = 0; index < 300; index++) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("loop connect", () => {
  test("a client that closes before the handshake completes claims nothing and releases nothing", async () => {
    // Claude Code starts a stdio server, sends initialize, closes it, then
    // starts it again. The first process must leave no lease behind.
    const { endpoint, state } = fakeServer();
    const input = new Lines();
    const written: Record<string, unknown>[] = [];
    const running = runConnectCommand(
      [
        "connect",
        "--as",
        RECIPIENT,
        "--deliver",
        "claude",
        "--session",
        "probe-1",
      ],
      {
        endpoint,
        input,
        log: () => undefined,
        write: (payload) => {
          written.push(payload as Record<string, unknown>);
          return Promise.resolve();
        },
      }
    );
    input.push({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await until(() => written.some((entry) => entry.id === 1), "initialize");
    input.end();
    const outcome = await running;
    expect(outcome.released).toBe(false);
    expect(state.lease).toBeUndefined();
  });

  test("claims its stream, pushes the Claude channel, acks on the recipient route, releases", async () => {
    const { endpoint, hub, state } = fakeServer();
    const input = new Lines();
    const written: Record<string, unknown>[] = [];
    const running = runConnectCommand(
      [
        "connect",
        "--as",
        RECIPIENT,
        "--deliver",
        "claude",
        "--session",
        "claude-session-1",
      ],
      {
        endpoint,
        input,
        log: () => undefined,
        write: (payload) => {
          written.push(payload as Record<string, unknown>);
          return Promise.resolve();
        },
      }
    );
    const response = (id: number) =>
      written.find((entry) => entry.id === id) as
        | { error?: { message: string }; result?: Record<string, unknown> }
        | undefined;
    input.push({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await until(() => response(1) !== undefined, "initialize");
    expect(response(1)?.result?.capabilities).toEqual({
      experimental: { "claude/channel": {} },
      tools: {},
    });
    // Nothing is claimed, and nothing pushed, before the client says it is
    // initialized: a probe that closes here holds no lease.
    const early = envelopeFor("early");
    await hub.append(early);
    await sleep(50);
    expect(state.lease).toBeUndefined();
    expect(written.some((entry) => entry.method)).toBe(false);
    input.push({ jsonrpc: "2.0", method: "notifications/initialized" });
    await until(() => state.lease !== undefined, "the claim");
    expect(state.lease?.locator).toEqual(
      connectLocator({ kind: "claude", sessionId: "claude-session-1" })
    );
    const late = envelopeFor("late");
    await hub.append(late);
    const channel = () =>
      written.filter(
        (entry) => entry.method === "notifications/claude/channel"
      ) as { params: { content: string; meta: Record<string, string> } }[];
    await until(() => channel().length === 2, "two channel notifications");
    expect(channel().map((entry) => entry.params.meta.message_id)).toEqual([
      "message-early",
      "message-late",
    ]);
    expect(channel()[0]?.params.content).toContain("please review early");
    expect(channel()[0]?.params.content).toContain(early.workflowId);
    expect(state.acks).toEqual([]);
    // The read ACK, with this session's own token, never completion.
    input.push({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { workflow_ids: [early.workflowId] },
        name: "inbox_ack",
      },
    });
    await until(() => response(2) !== undefined, "the ack");
    const ackText = (
      response(2)?.result?.content as { text: string }[] | undefined
    )?.[0]?.text;
    expect(JSON.parse(ackText ?? "{}")).toEqual({
      acknowledged: [{ phase: "acknowledged", workflowId: early.workflowId }],
      refused: [],
      workResultCompleted: false,
    });
    expect(state.acks.map((ack) => ack.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
    expect(
      state.acks.map((ack) => (ack.body as { operation: string }).operation)
    ).toEqual(["claim", "acknowledge"]);
    // Tool input cannot carry anything else.
    input.push({
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { as: "supervisor:other", workflow_ids: [late.workflowId] },
        name: "inbox_ack",
      },
    });
    await until(() => response(3) !== undefined, "the refused ack");
    expect(response(3)?.error?.message).toContain("workflow_ids");
    expect(state.acks).toHaveLength(2);
    input.push({ id: 4, jsonrpc: "2.0", method: "tools/list" });
    await until(() => response(4) !== undefined, "tools/list");
    expect(response(4)?.result?.tools).toEqual(CONNECT_TOOLS);
    input.end();
    const outcome = await running;
    expect(outcome).toEqual({ end: { reason: "aborted" }, released: true });
    expect(state.releases).toEqual([
      {
        epoch: 1,
        holderRef: state.lease?.holderRef,
        schema: "supervisor-endpoint-session-release.v2",
        supervisorId: RECIPIENT,
      },
    ]);
  });

  test("argv fixes the identity and refuses what a kind does not take", () => {
    expect(
      parseConnectArgs([
        "connect",
        "--as",
        RECIPIENT,
        "--deliver",
        "codex",
        "--thread",
        "thread-1",
        "--codex-remote",
        "ws://127.0.0.1:4500",
      ]).target
    ).toEqual({
      kind: "codex",
      remoteUrl: "ws://127.0.0.1:4500",
      threadId: "thread-1",
    });
    const refused = [
      ["--deliver", "claude"],
      ["--deliver", "claude", "--session", "s", "--thread", "t"],
      [
        "--deliver",
        "codex",
        "--thread",
        "t",
        "--codex-remote",
        "ws://10.0.0.2:4500",
      ],
      [
        "--deliver",
        "codex",
        "--thread",
        "t",
        "--codex-remote",
        "http://127.0.0.1:1",
      ],
      ["--deliver", "seat", "--run", "r", "--seat", "oss"],
      ["--deliver", "mailbox"],
    ];
    for (const args of refused) {
      expect(() =>
        parseConnectArgs(["connect", "--as", RECIPIENT, ...args])
      ).toThrow();
    }
    expect(() =>
      parseConnectArgs([
        "connect",
        "--as",
        "not-a-supervisor",
        "--deliver",
        "claude",
        "--session",
        "s",
      ])
    ).toThrow();
  });

  test("Codex delivery injects the formatted message on a loopback thread only", async () => {
    const calls: [string, string, string][] = [];
    const deliver = codexThreadDeliverer(
      "ws://127.0.0.1:4500",
      "thread-1",
      (remote, thread, prompt) => {
        calls.push([remote, thread, prompt]);
        return Promise.resolve(true);
      }
    );
    const envelope = envelopeFor("codex");
    expect(
      await deliver({
        appendedAt: "2026-10-11T00:00:00.000Z",
        envelope,
        schema: "supervisor-inbox-event.v1",
        seq: 1,
      })
    ).toBe(true);
    expect(calls[0]?.[0]).toBe("ws://127.0.0.1:4500");
    expect(calls[0]?.[2]).toContain("please review codex");
    expect(calls[0]?.[2]).toContain(envelope.workflowId);
    const remote = codexThreadDeliverer("ws://10.1.1.1:4500", "t", () =>
      Promise.resolve(true)
    );
    await expect(
      remote({
        appendedAt: "2026-10-11T00:00:00.000Z",
        envelope,
        schema: "supervisor-inbox-event.v1",
        seq: 1,
      })
    ).rejects.toThrow();
  });
});

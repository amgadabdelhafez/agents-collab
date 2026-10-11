// ra1: the outbound, resumable inbox stream. The store is the real PostgreSQL
// inbox (a disposable container) beside the real V2 ledger, whose start
// intents decide what is still unacknowledged; the stream handler and the
// client are the production ones, over a real loopback listener where the
// transport matters.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { SQL, serve, sleep } from "bun";
import { A2AClientEndpoint } from "../../src/loop/a2a-session-client";
import {
  A2A_V2_LEASE_EPOCH_HEADER,
  A2A_V2_LEASE_HOLDER_HEADER,
  a2aV2SessionInboxPath,
  matchA2AV2Route,
} from "../../src/loop/a2a-v2-routes-contract";
import {
  InboxStreamClient,
  type InboxStreamFrame,
  parseInboxStreamEvent,
  parseInboxStreamFrames,
} from "../../src/loop/inbox-stream-client";
import {
  parseSupervisorEndpointLocator,
  type SupervisorEndpointLeaseV2,
  supervisorEndpointDescriptorIdentity,
} from "../../src/loop/supervisor-endpoint-lease";
import {
  createSupervisorInboxStreamHandler,
  PostgresSupervisorInboxStore,
  SUPERVISOR_INBOX_FULL_REASON,
  type SupervisorInboxEvent,
  SupervisorInboxPresence,
  type SupervisorInboxStore,
  SupervisorInboxStreamHub,
  type SupervisorInboxStreamLimits,
  supervisorInboxEventFrame,
} from "../../src/loop/supervisor-inbox-stream";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { createInboxStreamEndpointAdapter } from "../../src/loop/supervisor-message-v2-endpoint-delivery";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";
import { DisposablePostgres } from "../support/disposable-postgres";

setDefaultTimeout(30_000);

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 fixture");
}
/** The sender's scope; the route tenant is its tenant. */
const SENDER: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const TENANT = SENDER.tenantId;
const DEPLOYMENT = "inbox-test-queue";
const TARGET_PRINCIPAL = "principal:target";
const OTHER = "supervisor:other";
const PRINCIPALS: Record<string, string> = {
  [OTHER]: "principal:other",
};
const TOKENS: Record<string, string> = { "token-other": OTHER };

let postgres: DisposablePostgres;
let raw: SQL;
const opened: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
}, 90_000);

afterEach(async () => {
  for (const resource of opened.splice(0).reverse()) {
    await resource.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await raw?.close({ timeout: 0 });
  await postgres?.close();
});

/** A database of its own: the ledger's start intents and the inbox. */
const freshStores = async (
  limits: { maxPending?: number } = {}
): Promise<{
  inbox: PostgresSupervisorInboxStore;
  ledger: PostgresSupervisorMessageV2DeliveryLedger;
}> => {
  const name = `inbox_${randomUUID().replaceAll("-", "")}`;
  await raw.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(postgres.databaseUrl());
  url.pathname = `/${name}`;
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    url.toString(),
    {
      buildId: "inbox-test.v1",
      deployment: DEPLOYMENT,
      workflowIdFormat: "deployment",
    }
  );
  opened.push(ledger);
  await ledger.migrate();
  const inbox = await PostgresSupervisorInboxStore.connect(
    url.toString(),
    limits
  );
  opened.push(inbox);
  await inbox.migrate();
  return { inbox, ledger };
};

const inputFor = (
  key: string,
  to: string,
  body = `body ${key}`
): SupervisorMessageV2Input => ({
  ...structuredClone(fixture.input),
  body,
  dedupeKey: key,
  messageId: `message-${key}`,
  threadId: `thread-${key}`,
  to,
});

const envelopeFor = (
  input: SupervisorMessageV2Input,
  attempt = 1
): SupervisorMessageV2DeliveryEnvelope => {
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    SENDER,
    input.dedupeKey,
    DEPLOYMENT
  );
  const deliveryId = deriveSupervisorMessageV2DeliveryId(
    SENDER,
    workflowId,
    attempt
  );
  return {
    artifactRefs: [...input.artifactRefs],
    body: input.body,
    deliveryAttempt: attempt,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: input.messageId,
    principal: SENDER.principal,
    schema: "supervisor-message-delivery.v2",
    target: input.to,
    tenantId: SENDER.tenantId,
    threadId: input.threadId,
    workflowId,
  };
};

/** A fresh recipient per test, so tests never share an inbox. */
const freshRecipient = () =>
  `supervisor:r-${randomUUID().slice(0, 8)}` as const;

const leaseFor = (
  recipient: string,
  overrides: Partial<SupervisorEndpointLeaseV2> = {}
): SupervisorEndpointLeaseV2 => ({
  descriptorId: "descriptor:1",
  descriptorRevision: 1,
  epoch: 3,
  expiresAt: "2099-01-01T00:00:00.000Z",
  holderRef: "connect:holder-a",
  kind: "inbox-stream",
  locator: { agent: "claude", kind: "inbox-stream", sessionId: "session-1" },
  principal: TARGET_PRINCIPAL,
  recipient,
  releasedAt: null,
  schema: "supervisor-endpoint-lease.v2",
  tenantId: TENANT,
  ...overrides,
});

/** The route under test for one recipient, with a mutable lease row. */
const routeFor = (
  recipient: string,
  hub: SupervisorInboxStreamHub,
  limits: Partial<SupervisorInboxStreamLimits> = {}
) => {
  const tokens: Record<string, string> = { ...TOKENS, "token-r": recipient };
  const principals: Record<string, string> = {
    ...PRINCIPALS,
    [recipient]: TARGET_PRINCIPAL,
  };
  const state: { lease: SupervisorEndpointLeaseV2 | undefined } = {
    lease: leaseFor(recipient),
  };
  const handler = createSupervisorInboxStreamHandler({
    authenticator: {
      authenticate: (request: Request) => {
        const token = (request.headers.get("authorization") ?? "").replace(
          "Bearer ",
          ""
        );
        const supervisorId = tokens[token];
        return supervisorId
          ? { principal: principals[supervisorId] as string, supervisorId }
          : undefined;
      },
    },
    hub,
    leases: () => ({
      resolve: () =>
        Promise.resolve(
          state.lease
            ? { lease: state.lease, state: "live" as const }
            : { state: "none" as const }
        ),
    }),
    limits: { heartbeatMs: 60_000, retryMs: 10, ...limits },
    principalForRecipient: (id) => principals[id],
    tenant: TENANT,
  });
  return { handler, state };
};

const ROUTE = "/a2a/v2";
const streamRequest = (
  recipient: string,
  headers: Record<string, string> = {}
): Request =>
  new Request(`http://127.0.0.1${a2aV2SessionInboxPath(ROUTE, recipient)}`, {
    headers: {
      authorization: "Bearer token-r",
      [A2A_V2_LEASE_EPOCH_HEADER]: "3",
      [A2A_V2_LEASE_HOLDER_HEADER]: "connect:holder-a",
      ...headers,
    },
  });

/** Reads frames until `count` message events (or the stream ends). */
const readMessages = async (
  frames: AsyncGenerator<InboxStreamFrame>,
  count: number
): Promise<{
  ended: boolean;
  events: SupervisorInboxEvent[];
  other: string[];
}> => {
  const events: SupervisorInboxEvent[] = [];
  const other: string[] = [];
  while (events.length < count) {
    const next = await frames.next();
    if (next.done) {
      return { ended: true, events, other };
    }
    if (next.value.event === "message") {
      events.push(parseInboxStreamEvent(next.value));
    } else {
      other.push(next.value.event);
    }
  }
  return { ended: false, events, other };
};

/** An HTTP/1.1 chunked body, decoded (a raw socket sees the framing). */
const dechunk = (bytes: Buffer): string => {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const lineEnd = bytes.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(
      bytes.subarray(offset, lineEnd).toString("latin1"),
      16
    );
    if (!(size > 0)) {
      break;
    }
    parts.push(bytes.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts).toString("utf8");
};

const appendAll = async (
  hub: SupervisorInboxStreamHub,
  recipient: string,
  keys: readonly string[],
  body?: (key: string) => string
): Promise<string[]> => {
  const ids: string[] = [];
  for (const key of keys) {
    const envelope = envelopeFor(inputFor(key, recipient, body?.(key)));
    const result = await hub.append(envelope);
    expect(result?.status).toBe("appended");
    ids.push(envelope.workflowId);
  }
  return ids;
};

describe("ra1 route contract", () => {
  test("matches exactly {routePath}/sessions/<slug>/inbox", () => {
    expect(matchA2AV2Route(ROUTE, "/a2a/v2/sessions/target/inbox")).toEqual({
      method: "GET",
      route: "session-inbox",
      supervisorId: "supervisor:target",
    });
    expect(matchA2AV2Route(ROUTE, "/a2a/v2/sessions/claim")).toEqual({
      method: "POST",
      operation: "claim",
      route: "session",
    });
    for (const path of [
      "/a2a/v2/sessions/target/inbox/",
      "/a2a/v2/sessions/a/b/inbox",
      "/a2a/v2/sessions/Target/inbox",
      "/a2a/v2/sessions//inbox",
      "/a2a/v2/sessions/inbox",
      "/a2a/v2/sessions/target-inbox",
      "/a2a/v2/sessions/target",
    ]) {
      expect(matchA2AV2Route(ROUTE, path)).toBeUndefined();
    }
  });

  test("an inbox-stream locator is ids only and binds its sessionRef", () => {
    const locator = {
      agent: "codex",
      kind: "inbox-stream",
      sessionId: "thread-1",
    };
    expect(parseSupervisorEndpointLocator(locator)).toEqual(locator as never);
    expect(() =>
      parseSupervisorEndpointLocator({ ...locator, path: "/tmp" })
    ).toThrow();
    expect(() =>
      parseSupervisorEndpointLocator({ ...locator, agent: "oss" })
    ).toThrow();
    expect(() =>
      parseSupervisorEndpointLocator({ ...locator, sessionId: "../x" })
    ).toThrow();
    expect(
      supervisorEndpointDescriptorIdentity(
        parseSupervisorEndpointLocator(locator),
        "session:thread-1"
      ).provider
    ).toBe("codex-app-server");
    expect(() =>
      supervisorEndpointDescriptorIdentity(
        parseSupervisorEndpointLocator(locator),
        "session:another"
      )
    ).toThrow("sessionRef does not name the inbox-stream session");
  });
});

describe("ra1 inbox store on PostgreSQL", () => {
  test("one row per message, in sequence order; acknowledged messages leave the stream", async () => {
    const { inbox, ledger } = await freshStores();
    const recipient = freshRecipient();
    const first = inputFor("first", recipient);
    const second = inputFor("second", recipient);
    const appended = await inbox.append(envelopeFor(first, 1));
    // A retried attempt of the same message appends nothing new.
    const retried = await inbox.append(envelopeFor(first, 2));
    const next = await inbox.append(envelopeFor(second));
    expect(appended.status).toBe("appended");
    expect(retried).toEqual({
      seq: (appended as { seq: number }).seq,
      status: "duplicate",
    });
    expect((next as { seq: number }).seq).toBeGreaterThan(
      (appended as { seq: number }).seq
    );
    const read = async (after = 0) =>
      (await inbox.read({ after, limit: 10, recipient, tenantId: TENANT })).map(
        (entry) => entry.envelope.messageId
      );
    expect(await read()).toEqual([first.messageId, second.messageId]);
    expect(await read((appended as { seq: number }).seq)).toEqual([
      second.messageId,
    ]);
    // Another tenant or recipient sees nothing.
    expect(
      await inbox.read({ after: 0, limit: 10, recipient, tenantId: "tenant:x" })
    ).toEqual([]);
    // The read ACK makes the message terminal: it is not replayed.
    const workflowId = envelopeFor(first).workflowId;
    await ledger.recordStartIntent(workflowId, SENDER, first);
    await ledger.recordTerminalOutcome(workflowId, SENDER, "acknowledged");
    expect(await read()).toEqual([second.messageId]);
  });

  test("a full inbox refuses further messages until one is acknowledged", async () => {
    const { inbox, ledger } = await freshStores({ maxPending: 2 });
    const recipient = freshRecipient();
    const inputs = ["a", "b", "c"].map((key) => inputFor(key, recipient));
    const [a, b, c] = inputs as [
      SupervisorMessageV2Input,
      SupervisorMessageV2Input,
      SupervisorMessageV2Input,
    ];
    expect((await inbox.append(envelopeFor(a))).status).toBe("appended");
    expect((await inbox.append(envelopeFor(b))).status).toBe("appended");
    expect(await inbox.append(envelopeFor(c))).toEqual({ status: "full" });
    // Another recipient's inbox is its own.
    expect(
      (await inbox.append(envelopeFor(inputFor("d", freshRecipient())))).status
    ).toBe("appended");
    const workflowId = envelopeFor(a).workflowId;
    await ledger.recordStartIntent(workflowId, SENDER, a);
    await ledger.recordTerminalOutcome(workflowId, SENDER, "acknowledged");
    expect((await inbox.append(envelopeFor(c))).status).toBe("appended");
  });

  test("the inbox-stream adapter accepts into the inbox, refuses a full one, and probes presence", async () => {
    const { inbox } = await freshStores({ maxPending: 1 });
    let now = 1_000_000;
    const hub = new SupervisorInboxStreamHub({
      presence: new SupervisorInboxPresence({ graceMs: 1000, now: () => now }),
    });
    hub.attach(inbox);
    const recipient = freshRecipient();
    const lease = leaseFor(recipient) as never;
    const endpoint = {
      agent: "claude" as const,
      kind: "inbox-stream" as const,
      sessionId: "session-1",
    };
    const adapter = createInboxStreamEndpointAdapter({ inboxStream: hub });
    expect(
      await adapter.deliver({
        endpoint,
        envelope: envelopeFor(inputFor("one", recipient)),
        lease,
      })
    ).toEqual({ status: "accepted" });
    expect(
      await adapter.deliver({
        endpoint,
        envelope: envelopeFor(inputFor("two", recipient)),
        lease,
      })
    ).toEqual({
      reason: SUPERVISOR_INBOX_FULL_REASON,
      status: "transient-failure",
    });
    // A lease for another recipient never appends this envelope.
    expect(
      (
        await adapter.deliver({
          endpoint,
          envelope: envelopeFor(inputFor("three", freshRecipient())),
          lease,
        })
      ).status
    ).toBe("transient-failure");
    const descriptor = {
      sessionRef: "session:session-1",
    } as SupervisorSessionDescriptorV2;
    const probe = () => adapter.probe({ descriptor, endpoint, lease });
    expect(await probe()).toBe(false);
    const leave = hub.presence.open(TENANT, recipient, {
      epoch: 3,
      holderRef: "connect:holder-a",
    });
    expect(await probe()).toBe(true);
    expect(
      await adapter.probe({
        descriptor: { sessionRef: "session:other" } as never,
        endpoint,
        lease,
      })
    ).toBe(false);
    leave();
    now += 999;
    expect(await probe()).toBe(true);
    now += 2;
    expect(await probe()).toBe(false);
    // Without the hub nothing is ready and nothing is appended.
    const bare = createInboxStreamEndpointAdapter();
    expect(await bare.probe({ descriptor, endpoint, lease })).toBe(false);
    expect(
      (
        await bare.deliver({
          endpoint,
          envelope: envelopeFor(inputFor("four", recipient)),
          lease,
        })
      ).status
    ).toBe("transient-failure");
  });
});

describe("ra1 inbox stream route", () => {
  test("requires the bearer, the path's own identity and the lease fence", async () => {
    const { inbox } = await freshStores();
    const hub = new SupervisorInboxStreamHub();
    hub.attach(inbox);
    const recipient = freshRecipient();
    const { handler, state } = routeFor(recipient, hub);
    const status = async (request: Request) => {
      const response = await handler(request, recipient);
      if (response.status === 200) {
        await response.body?.cancel();
        return { status: 200 };
      }
      const body = (await response.json()) as {
        error: { code: string; reason?: string };
      };
      return { error: body.error, status: response.status };
    };
    expect(
      await status(streamRequest(recipient, { authorization: "" }))
    ).toEqual({ error: { code: "unauthenticated" }, status: 401 });
    expect(
      await status(streamRequest(recipient, { authorization: "Bearer nope" }))
    ).toEqual({ error: { code: "unauthenticated" }, status: 401 });
    // Another configured supervisor's token cannot read this inbox.
    expect(
      await status(
        streamRequest(recipient, { authorization: "Bearer token-other" })
      )
    ).toEqual({ error: { code: "identity-mismatch" }, status: 403 });
    expect(
      await status(
        streamRequest(recipient, { [A2A_V2_LEASE_EPOCH_HEADER]: "" })
      )
    ).toEqual({ error: { code: "request-invalid" }, status: 400 });
    expect(
      await status(streamRequest(recipient, { "last-event-id": "1e3" }))
    ).toEqual({ error: { code: "request-invalid" }, status: 400 });
    expect(
      await status(
        streamRequest(recipient, { [A2A_V2_LEASE_EPOCH_HEADER]: "2" })
      )
    ).toEqual({
      error: { code: "lease-fenced", reason: "epoch-mismatch" },
      status: 409,
    });
    expect(
      await status(
        streamRequest(recipient, {
          [A2A_V2_LEASE_HOLDER_HEADER]: "connect:holder-b",
        })
      )
    ).toEqual({
      error: { code: "lease-fenced", reason: "holder-mismatch" },
      status: 409,
    });
    const fenced = (reason: string) => ({
      error: { code: "lease-fenced", reason },
      status: 409,
    });
    // A lease of another kind names no stream.
    state.lease = leaseFor(recipient, {
      kind: "claude-channel",
      locator: { kind: "claude-channel", sessionId: "s" },
    });
    expect(await status(streamRequest(recipient))).toEqual(fenced("absent"));
    // Another seat's principal on the row: not this seat's lease.
    state.lease = leaseFor(recipient, { principal: "principal:other" });
    expect(await status(streamRequest(recipient))).toEqual(fenced("absent"));
    state.lease = leaseFor(recipient, {
      releasedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(await status(streamRequest(recipient))).toEqual(fenced("released"));
    state.lease = undefined;
    expect(await status(streamRequest(recipient))).toEqual(fenced("absent"));
    // An expired, unreleased lease is still its holder's to reconnect to.
    state.lease = leaseFor(recipient, {
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(await status(streamRequest(recipient))).toEqual({ status: 200 });
    state.lease = leaseFor(recipient);
    const ok = await handler(streamRequest(recipient), recipient);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    await ok.body?.cancel();
    // A detached hub (service closing) serves nothing.
    hub.detach();
    expect((await status(streamRequest(recipient))).status).toBe(503);
  });

  test("a wake delivers without a read timer; a heartbeat reads nothing", async () => {
    const { inbox } = await freshStores();
    let reads = 0;
    const counting: SupervisorInboxStore = {
      append: (envelope) => inbox.append(envelope),
      close: () => Promise.resolve(),
      read: (input) => {
        reads += 1;
        return inbox.read(input);
      },
    };
    const hub = new SupervisorInboxStreamHub();
    hub.attach(counting);
    const recipient = freshRecipient();
    const { handler } = routeFor(recipient, hub, { heartbeatMs: 40 });
    const response = await handler(streamRequest(recipient), recipient);
    const frames = parseInboxStreamFrames(
      response.body as ReadableStream<Uint8Array>
    );
    // Several heartbeats pass with nothing new: one read, at connect.
    await sleep(200);
    expect(reads).toBe(1);
    await appendAll(hub, recipient, ["woken"]);
    const got = await readMessages(frames, 1);
    expect(got.events.map((event) => event.envelope.messageId)).toEqual([
      "message-woken",
    ]);
    expect(reads).toBe(2);
    await frames.return(undefined);
  });

  test("reconnect resumes from Last-Event-ID without loss or duplicate", async () => {
    const { inbox } = await freshStores();
    const hub = new SupervisorInboxStreamHub();
    hub.attach(inbox);
    const recipient = freshRecipient();
    const { handler } = routeFor(recipient, hub);
    await appendAll(hub, recipient, ["m1", "m2", "m3", "m4"]);
    const first = await handler(streamRequest(recipient), recipient);
    const firstFrames = parseInboxStreamFrames(
      first.body as ReadableStream<Uint8Array>
    );
    const head = await readMessages(firstFrames, 2);
    const seen = head.events.map((event) => event.seq);
    // The connection drops after two events.
    await firstFrames.return(undefined);
    await appendAll(hub, recipient, ["m5"]);
    const resumed = await handler(
      streamRequest(recipient, { "last-event-id": String(seen.at(-1)) }),
      recipient
    );
    const resumedFrames = parseInboxStreamFrames(
      resumed.body as ReadableStream<Uint8Array>
    );
    const tail = await readMessages(resumedFrames, 3);
    await resumedFrames.return(undefined);
    const all = [...head.events, ...tail.events].map(
      (event) => event.envelope.messageId
    );
    expect(all).toEqual(
      ["m1", "m2", "m3", "m4", "m5"].map((k) => `message-${k}`)
    );
    const seqs = [...head.events, ...tail.events].map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("a slow consumer over a real socket is bounded, disconnected, and resumes without loss", async () => {
    const { inbox } = await freshStores();
    // Entries read from the store, and when the server ended the stream.
    let entriesRead = 0;
    const counting: SupervisorInboxStore = {
      append: (envelope) => inbox.append(envelope),
      close: () => Promise.resolve(),
      read: async (input) => {
        const entries = await inbox.read(input);
        entriesRead += entries.length;
        return entries;
      },
    };
    // No grace: presence is exactly "a stream is open on the server".
    const hub = new SupervisorInboxStreamHub({
      presence: new SupervisorInboxPresence({ graceMs: -1 }),
    });
    hub.attach(counting);
    const recipient = freshRecipient();
    const readBatch = 4;
    const { handler } = routeFor(recipient, hub, {
      maxBufferedBytes: 4096,
      readBatch,
      stallMs: 200,
    });
    // ~2.6 MiB: more than the loopback socket buffers hold, so a reader that
    // stops reading is felt by the server as backpressure.
    const keys = Array.from({ length: 90 }, (_, index) => `slow-${index}`);
    await appendAll(
      hub,
      recipient,
      keys,
      (key) => `${key} ${"x".repeat(30 * 1024)}`
    );
    const server = serve({
      fetch: (request) => handler(request, recipient),
      hostname: "127.0.0.1",
      port: 0,
    });
    const fence = { epoch: 3, holderRef: "connect:holder-a" };
    try {
      // A raw HTTP/1.1 client that sends the request and then reads nothing.
      const socket = connect({
        host: "127.0.0.1",
        port: server.port as number,
      });
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.pause();
      socket.write(
        [
          `GET ${a2aV2SessionInboxPath(ROUTE, recipient)} HTTP/1.1`,
          `host: 127.0.0.1:${server.port}`,
          "authorization: Bearer token-r",
          `${A2A_V2_LEASE_EPOCH_HEADER}: 3`,
          `${A2A_V2_LEASE_HOLDER_HEADER}: connect:holder-a`,
          "accept: text/event-stream",
          // The socket ends with the response, not at the idle timeout.
          "connection: close",
          "",
          "",
        ].join("\r\n")
      );
      for (
        let index = 0;
        index < 50 && !hub.presence.isPresent(TENANT, recipient, fence);
        index++
      ) {
        await sleep(10);
      }
      expect(hub.presence.isPresent(TENANT, recipient, fence)).toBe(true);
      // The server, not the client, ends a stalled stream.
      for (
        let index = 0;
        index < 300 && hub.presence.isPresent(TENANT, recipient, fence);
        index++
      ) {
        await sleep(20);
      }
      expect(hub.presence.isPresent(TENANT, recipient, fence)).toBe(false);
      // Bounded: it stopped reading the inbox once the socket and its queue
      // were full; at most one batch was read and not written.
      expect(entriesRead).toBeLessThan(keys.length);
      // The reader drains what was already sent: the events, then overflow.
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise((resolve) => socket.once("end", resolve));
      socket.resume();
      await ended;
      socket.destroy();
      const raw = Buffer.concat(chunks);
      const head = raw.indexOf("\r\n\r\n");
      const headers = raw.subarray(0, head).toString("latin1");
      expect(headers).toStartWith("HTTP/1.1 200");
      const body = /transfer-encoding: chunked/i.test(headers)
        ? dechunk(raw.subarray(head + 4))
        : raw.subarray(head + 4).toString("utf8");
      expect(body).toContain("event: overflow");
      const got = await readMessages(
        parseInboxStreamFrames(
          new Response(body).body as ReadableStream<Uint8Array>
        ),
        keys.length
      );
      expect(got.ended).toBe(true);
      expect(got.other).toContain("overflow");
      const events = got.events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThan(keys.length);
      expect(entriesRead - events.length).toBeLessThanOrEqual(readBatch);
      // It reconnects over the socket from its own Last-Event-ID and gets the
      // rest exactly once.
      const resumed = await fetch(
        `http://127.0.0.1:${server.port}${a2aV2SessionInboxPath(ROUTE, recipient)}`,
        {
          headers: {
            authorization: "Bearer token-r",
            "last-event-id": String(events.at(-1)?.seq),
            [A2A_V2_LEASE_EPOCH_HEADER]: "3",
            [A2A_V2_LEASE_HOLDER_HEADER]: "connect:holder-a",
          },
        }
      );
      const rest = await readMessages(
        parseInboxStreamFrames(resumed.body as ReadableStream<Uint8Array>),
        keys.length - events.length
      );
      await resumed.body?.cancel().catch(() => undefined);
      expect(
        [...events, ...rest.events].map((event) => event.envelope.messageId)
      ).toEqual(keys.map((key) => `message-${key}`));
    } finally {
      server.stop(true);
    }
  });

  test("a takeover fences the open stream", async () => {
    const { inbox } = await freshStores();
    const hub = new SupervisorInboxStreamHub();
    hub.attach(inbox);
    const recipient = freshRecipient();
    const { handler, state } = routeFor(recipient, hub);
    const response = await handler(streamRequest(recipient), recipient);
    const frames = parseInboxStreamFrames(
      response.body as ReadableStream<Uint8Array>
    );
    expect(
      hub.presence.isPresent(TENANT, recipient, {
        epoch: 3,
        holderRef: "connect:holder-a",
      })
    ).toBe(true);
    state.lease = leaseFor(recipient, { epoch: 4, holderRef: "connect:b" });
    // The session route wakes the recipient after a claim.
    hub.wake(TENANT, recipient);
    const got = await readMessages(frames, 1);
    expect(got.other).toContain("fenced");
    expect(got.ended).toBe(true);
  });
});

describe("ra1 inbox stream client", () => {
  test("delivers each event once across a dropped connection and a failed delivery", async () => {
    const { inbox } = await freshStores();
    const hub = new SupervisorInboxStreamHub();
    hub.attach(inbox);
    const recipient = freshRecipient();
    const { handler } = routeFor(recipient, hub);
    const lastEventIds: (string | null)[] = [];
    let dropFirst = true;
    const server = serve({
      fetch: async (request) => {
        lastEventIds.push(request.headers.get("last-event-id"));
        const response = await handler(request, recipient);
        if (!(dropFirst && response.body)) {
          return response;
        }
        // The first connection drops after its first message event.
        dropFirst = false;
        const source = response.body.getReader();
        let messages = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await source.read();
              if (done) {
                controller.close();
                return;
              }
              controller.enqueue(value);
              messages += (
                new TextDecoder().decode(value).match(/event: message/g) ?? []
              ).length;
              if (messages >= 1) {
                await source.cancel();
                controller.close();
              }
            },
          }),
          { headers: response.headers }
        );
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      await appendAll(hub, recipient, ["c1", "c2", "c3"]);
      const delivered: string[] = [];
      let failOnce = true;
      const abort = new AbortController();
      const client = new InboxStreamClient({
        deliver: (event) => {
          if (event.envelope.messageId === "message-c3" && failOnce) {
            failOnce = false;
            return Promise.resolve(false);
          }
          delivered.push(event.envelope.messageId);
          if (delivered.length === 5) {
            abort.abort();
          }
          return Promise.resolve(true);
        },
        endpoint: new A2AClientEndpoint({
          baseUrl: `http://127.0.0.1:${server.port}`,
          routePath: ROUTE,
          supervisorId: recipient,
          token: "token-r",
        }),
        fence: { epoch: 3, holderRef: "connect:holder-a" },
        minBackoffMs: 10,
        signal: abort.signal,
      });
      const run = client.run();
      // Messages that arrive while the stream is held are woken, not polled.
      const waitFor = async (count: number) => {
        for (let index = 0; index < 200 && delivered.length < count; index++) {
          await sleep(10);
        }
      };
      await waitFor(3);
      await appendAll(hub, recipient, ["c4", "c5"]);
      expect(await run).toEqual({ reason: "aborted" });
      expect(delivered).toEqual(
        ["c1", "c2", "c3", "c4", "c5"].map((key) => `message-${key}`)
      );
      // Connect without a cursor, resume after c1 (the drop), then after c2
      // (the failed delivery of c3).
      expect(lastEventIds.slice(0, 3)).toEqual([null, "1", "2"]);
    } finally {
      server.stop(true);
    }
  });

  test("an event at or below the cursor is never delivered again, even when a server replays it", async () => {
    const recipient = freshRecipient();
    const frame = (seq: number) =>
      supervisorInboxEventFrame({
        appendedAt: "2026-10-11T00:00:00.000Z",
        envelope: envelopeFor(inputFor(`replay-${seq}`, recipient)),
        seq,
      });
    // A server that ignores Last-Event-ID: the second connection repeats 2.
    const connections = [
      `retry: 1\n\n${frame(1)}${frame(2)}`,
      `${frame(2)}${frame(3)}`,
    ];
    const abort = new AbortController();
    const delivered: number[] = [];
    const client = new InboxStreamClient({
      deliver: (event) => {
        delivered.push(event.seq);
        if (event.seq === 3) {
          abort.abort();
        }
        return Promise.resolve(true);
      },
      endpoint: new A2AClientEndpoint({
        baseUrl: "http://127.0.0.1:1",
        routePath: ROUTE,
        supervisorId: recipient,
        token: "token-r",
      }),
      fence: { epoch: 3, holderRef: "connect:holder-a" },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(connections.shift() ?? "", {
            headers: { "content-type": "text/event-stream" },
          })
        )) as unknown as typeof fetch,
      minBackoffMs: 1,
      signal: abort.signal,
    });
    expect(await client.run()).toEqual({ reason: "aborted" });
    expect(delivered).toEqual([1, 2, 3]);
    expect(client.cursor).toBe(3);
  });

  test("an unparseable event is never skipped: the client resyncs from its Last-Event-ID", async () => {
    const recipient = freshRecipient();
    const frame = (seq: number) =>
      supervisorInboxEventFrame({
        appendedAt: "2026-10-11T00:00:00.000Z",
        envelope: envelopeFor(inputFor(`resync-${seq}`, recipient)),
        seq,
      });
    // The first connection garbles event 2 in transit; the next one, asked
    // to resume after 1, carries it intact.
    const connections = [
      `retry: 1\n\n${frame(1)}id: 2\nevent: message\ndata: {"schema":"garbled\n\n${frame(3)}`,
      `${frame(2)}${frame(3)}`,
    ];
    const lastEventIds: (null | string)[] = [];
    const abort = new AbortController();
    const delivered: number[] = [];
    const logged: string[] = [];
    const client = new InboxStreamClient({
      deliver: (event) => {
        delivered.push(event.seq);
        if (event.seq === 3) {
          abort.abort();
        }
        return Promise.resolve(true);
      },
      endpoint: new A2AClientEndpoint({
        baseUrl: "http://127.0.0.1:1",
        routePath: ROUTE,
        supervisorId: recipient,
        token: "token-r",
      }),
      fence: { epoch: 3, holderRef: "connect:holder-a" },
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        lastEventIds.push(
          new Headers(init?.headers).get("last-event-id") ?? null
        );
        return Promise.resolve(
          new Response(connections.shift() ?? "", {
            headers: { "content-type": "text/event-stream" },
          })
        );
      }) as unknown as typeof fetch,
      log: (line) => logged.push(line),
      minBackoffMs: 1,
      signal: abort.signal,
    });
    expect(await client.run()).toEqual({ reason: "aborted" });
    expect(delivered).toEqual([1, 2, 3]);
    expect(lastEventIds).toEqual([null, "1"]);
    expect(logged.join("\n")).toContain("resyncing after 1");
  });

  test("a fenced lease ends the client for good", async () => {
    const { inbox } = await freshStores();
    const hub = new SupervisorInboxStreamHub();
    hub.attach(inbox);
    const recipient = freshRecipient();
    const { handler, state } = routeFor(recipient, hub);
    state.lease = leaseFor(recipient, { epoch: 9 });
    const client = new InboxStreamClient({
      deliver: () => Promise.resolve(true),
      endpoint: new A2AClientEndpoint({
        baseUrl: "http://127.0.0.1:1",
        routePath: ROUTE,
        supervisorId: recipient,
        token: "token-r",
      }),
      fence: { epoch: 3, holderRef: "connect:holder-a" },
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init), recipient)) as typeof fetch,
      signal: new AbortController().signal,
    });
    expect(await client.run()).toEqual({
      detail: "epoch-mismatch",
      reason: "fenced",
    });
  });
});

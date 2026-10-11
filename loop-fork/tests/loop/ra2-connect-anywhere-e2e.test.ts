// ra2: a session behind NAT reaches a non-local orchestration server.
//
// The real orchestration server (runLoopOrchestrationServer) on a local
// Temporal dev server and a task-owned Docker PostgreSQL, with its RA1 token
// service, listens on loopback only; a throwaway TLS front (a self-signed CA
// generated here) serves it at https://localhost:<port>, as Caddy would. The
// "phone" session has its own HOME and a client-only config naming that
// origin, no listener of any kind, and no static token: it enrolls with a
// one-time code read from a file, trusts the CA through --trust-file, and
// holds its inbox stream with `loop connect`. The sender on the server host
// keeps using its static token over plaintext loopback. Nothing here reaches
// the operator's live state: every path is under one temp directory.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import {
  a2aMessageStatus,
  resolveA2AClientEndpoint,
  sendA2AMessage,
} from "../../src/loop/a2a-session-client";
import { runA2ACommand } from "../../src/loop/a2a-session-command";
import {
  a2aSessionCredentialPath,
  readA2ASessionCredential,
} from "../../src/loop/a2a-session-credential";
import { a2aV2MessageStatusPath } from "../../src/loop/a2a-v2-routes-contract";
import { runConnectCommand } from "../../src/loop/connect-command";
import {
  runLoopOrchestrationServer,
  tokenHostCommandForConfig,
} from "../../src/loop/loop-orchestration-server";
import { TOKEN_TTL_SECONDS } from "../../src/loop/orchestration-token-service";
import { supervisorEndpointRoots } from "../../src/loop/supervisor-endpoint-lease";
import { DisposablePostgres } from "../support/disposable-postgres";

let postgres: DisposablePostgres;
let temporal: TestWorkflowEnvironment;

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  temporal = await TestWorkflowEnvironment.createLocal();
}, 180_000);

afterAll(async () => {
  await temporal?.teardown();
  await postgres?.close();
});

const ROUTE = "/a2a/v2";
const DESK = "supervisor:ra2-desk";
const PHONE = "supervisor:ra2-phone";
const TREE = { project: "loop", repoKey: "agents-collab" };
const DESK_ROLE = { ...TREE, role: "supervisor" };
const PHONE_ROLE = { ...TREE, role: "worker" };
const PHONE_SESSION = "phone-claude-session-1";

const waitFor = async <T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 90_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const freePort = (): number => {
  const probe = serve({
    fetch: () => new Response(null),
    hostname: "127.0.0.1",
    port: 0,
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) {
    throw new Error("no free loopback port");
  }
  return port;
};

/** A throwaway CA and a server certificate for localhost and 127.0.0.1. */
const throwawayCa = (dir: string) => {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=ra2 throwaway CA"
  );
  openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost"
  );
  writeFileSync(
    join(dir, "server.ext"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n"
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "1",
    "-extfile",
    "server.ext"
  );
  rmSync(join(dir, "ca.key"));
  return {
    caFile: join(dir, "ca.pem"),
    cert: readFileSync(join(dir, "server.pem"), "utf8"),
    key: readFileSync(join(dir, "server.key"), "utf8"),
  };
};

/**
 * The TLS front: terminates TLS and forwards to the loopback listener,
 * streaming both ways, like Caddy's reverse_proxy. Stopping it drops every
 * open connection (the phone's network going away).
 */
const frontRequests: string[] = [];
/** The Last-Event-ID of each inbox stream request the front forwarded. */
const frontResumes: (null | string)[] = [];
const tlsFront = (input: {
  cert: string;
  key: string;
  port: number;
  upstreamPort: number;
}) =>
  serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      frontRequests.push(url.pathname);
      if (url.pathname.endsWith("/inbox")) {
        frontResumes.push(request.headers.get("last-event-id"));
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const upstream = await fetch(
        `http://127.0.0.1:${input.upstreamPort}${url.pathname}${url.search}`,
        {
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.arrayBuffer() }),
          headers,
          method: request.method,
          redirect: "manual",
          signal: request.signal,
        }
      );
      const out = new Headers(upstream.headers);
      out.delete("content-length");
      out.delete("transfer-encoding");
      return new Response(upstream.body, {
        headers: out,
        status: upstream.status,
      });
    },
    hostname: "127.0.0.1",
    port: input.port,
    tls: { cert: input.cert, key: input.key },
  });

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

interface ChannelNotification {
  method: string;
  params: { content: string; meta: { message_id: string } };
}

/** Where the channel notification naming `workflowId` was written. */
const channelIndex = (written: unknown[], workflowId: string): number =>
  written.findIndex(
    (payload) =>
      (payload as ChannelNotification).method ===
        "notifications/claude/channel" &&
      (payload as ChannelNotification).params.content.includes(workflowId)
  );

test("a session behind NAT enrolls over https, receives, ACKs, reconnects and resumes; its token refreshes and the static token never leaves loopback", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-e2e-")));
  const abort = new AbortController();
  const fronts: { stop(force?: boolean): void }[] = [];
  let running: Promise<void> | undefined;
  try {
    const ca = throwawayCa(join(root, "tls"));
    const serverHome = join(root, "server-home");
    mkdirSync(serverHome, { recursive: true });
    const port = freePort();
    const tlsPort = freePort();
    const origin = `https://localhost:${tlsPort}`;
    const tenant = `tenant:ra2-e2e-${randomUUID().slice(0, 8)}`;
    const mailboxOf = (id: string) =>
      join(root, "mail", `${id.slice("supervisor:".length)}.jsonl`);
    const serverConfigPath = join(root, "orchestration.json");
    writeFileSync(
      serverConfigPath,
      JSON.stringify({
        a2aV2: {
          databaseUrlEnv: "RA2_E2E_DATABASE_URL",
          endpointRef: "endpoint:loop-run",
          policy: {
            claimTimeoutMs: 120_000,
            escalationTimeoutMs: 240_000,
            maxDeliveryAttempts: 20,
            retryDelayMs: 1000,
          },
          principal: "principal:ra2-desk",
          routePath: ROUTE,
          sessionTtlMs: 30_000,
          tenant,
          workflowIdFormat: "legacy",
        },
        address: temporal.address,
        buildId: "ra2-connect-anywhere-e2e.v1",
        // The config needs one grant; a role-bound pair is decided by its
        // role subtree (desk supervises phone), which no grant widens.
        grants: [
          {
            from: DESK,
            operations: ["receive"],
            principal: "principal:ra2-desk",
            to: PHONE,
          },
        ],
        hostname: "127.0.0.1",
        identity: "loop-orchestration@ra2-e2e",
        namespace: "default",
        origin,
        port,
        schema: "loop-orchestration-server.v1",
        stateDir: join(root, "state"),
        supervisors: [
          {
            mailbox: mailboxOf(DESK),
            principal: "principal:ra2-desk",
            role: DESK_ROLE,
            supervisorId: DESK,
            tokenEnv: "RA2_DESK_TOKEN",
          },
          {
            mailbox: mailboxOf(PHONE),
            principal: "principal:ra2-phone",
            role: PHONE_ROLE,
            supervisorId: PHONE,
            tokenEnv: "RA2_PHONE_TOKEN",
          },
        ],
        taskQueue: `ra2-e2e-${randomUUID().slice(0, 8)}`,
        tokens: { signingKeyFile: join(root, "signing.pem") },
      })
    );
    const deskToken = randomUUID();
    const phoneStaticToken = randomUUID();
    const serverEnv: Record<string, string> = {
      HOME: serverHome,
      LOOP_ORCHESTRATION_CONFIG: serverConfigPath,
      RA2_DESK_TOKEN: deskToken,
      RA2_E2E_DATABASE_URL: postgres.databaseUrl(),
      RA2_PHONE_TOKEN: phoneStaticToken,
    };
    // The host operator makes the signing key, then the phone's code.
    tokenHostCommandForConfig(serverConfigPath, { command: "token-keygen" });
    running = runLoopOrchestrationServer(serverConfigPath, serverEnv, {
      a2aV2EndpointRoots: supervisorEndpointRoots(serverHome),
      signal: abort.signal,
    });
    const failed = running.then(
      () => "server stopped before it became ready",
      (error: unknown) =>
        `server failed: ${error instanceof Error ? error.message : String(error)}`
    );
    const ready = await Promise.race([
      failed,
      waitFor("the server to report ready", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(
          () => undefined
        );
        const body = (await response?.json().catch(() => undefined)) as
          | { state?: string }
          | undefined;
        return body?.state === "ready" ? "ready" : undefined;
      }),
    ]);
    expect(ready).toBe("ready");
    let front = tlsFront({ ...ca, port: tlsPort, upstreamPort: port });
    fronts.push(front);

    // The desk session on the server host: plaintext loopback, static token.
    const deskConfig = join(root, "desk-client.json");
    writeFileSync(
      deskConfig,
      JSON.stringify({
        a2aV2: { routePath: ROUTE },
        hostname: "127.0.0.1",
        port,
        supervisors: [{ supervisorId: DESK, tokenEnv: "RA2_DESK_TOKEN" }],
      })
    );
    const desk = resolveA2AClientEndpoint(DESK, {
      env: {
        HOME: serverHome,
        LOOP_ORCHESTRATION_CONFIG: deskConfig,
        RA2_DESK_TOKEN: deskToken,
      },
    });
    expect(desk.auth).toBe("static");

    // The phone: its own HOME, a client-only config, no listener, no token.
    const phoneHome = join(root, "phone-home");
    mkdirSync(phoneHome, { recursive: true });
    const phoneConfig = join(phoneHome, "orchestration.json");
    writeFileSync(
      phoneConfig,
      JSON.stringify({
        a2aV2: { routePath: ROUTE },
        origin,
        supervisors: [
          {
            role: PHONE_ROLE,
            supervisorId: PHONE,
            tokenEnv: "RA2_PHONE_TOKEN",
          },
        ],
      })
    );
    const phoneEnv: NodeJS.ProcessEnv = {
      HOME: phoneHome,
      LOOP_ORCHESTRATION_CONFIG: phoneConfig,
    };
    // Even holding a static token, the phone never sends it beyond loopback.
    let staticSent = false;
    const watching = ((
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      staticSent ||= JSON.stringify(init?.headers ?? {}).includes(
        phoneStaticToken
      );
      return fetch(input, init);
    }) as typeof fetch;
    await expect(
      runA2ACommand(
        ["a2a", "status", "--as", PHONE, "--message-id", "m-none"],
        {
          env: { ...phoneEnv, RA2_PHONE_TOKEN: phoneStaticToken },
          fetchImpl: watching,
        }
      )
    ).rejects.toThrow("a static token is only sent on loopback");
    expect(staticSent).toBe(false);

    const codeFile = join(root, "phone.code");
    tokenHostCommandForConfig(serverConfigPath, {
      command: "token-code",
      out: codeFile,
      supervisorId: PHONE,
    });
    const lines = new Lines();
    const written: unknown[] = [];
    const logs: string[] = [];
    const connected = runConnectCommand(
      [
        "connect",
        "--as",
        PHONE,
        "--deliver",
        "claude",
        "--session",
        PHONE_SESSION,
        "--enroll-code-file",
        codeFile,
        "--trust-file",
        ca.caFile,
      ],
      {
        deps: { env: phoneEnv },
        input: lines,
        log: (line) => logs.push(line),
        write: (payload) => {
          written.push(payload);
          return Promise.resolve();
        },
      }
    );
    const credentialPath = a2aSessionCredentialPath(PHONE, phoneEnv);
    await waitFor("the phone to enroll and claim its stream", () =>
      logs.some((line) => line.includes("holds its inbox stream"))
        ? true
        : undefined
    );
    const enrolled = readA2ASessionCredential(credentialPath);
    expect(enrolled?.origin).toBe(origin);
    // Nothing logged carries the token or the code.
    const code = readFileSync(codeFile, "utf8").trim();
    for (const line of logs) {
      expect(line).not.toContain(enrolled?.token ?? "?");
      expect(line).not.toContain(code);
    }
    lines.push({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    lines.push({ jsonrpc: "2.0", method: "notifications/initialized" });
    const channel = () =>
      written.filter(
        (payload): payload is ChannelNotification =>
          (payload as { method?: string }).method ===
          "notifications/claude/channel"
      );
    const sendToPhone = async (key: string) => {
      const receipt = await sendA2AMessage(desk, {
        body: `ra2 e2e ${key}: please review`,
        messageId: `ra2-${key}`,
        to: PHONE,
      });
      expect(receipt.accepted).toBe(true);
      return String(receipt.workflowId);
    };
    const statusOf = (workflowId: string) => a2aMessageStatus(desk, workflowId);
    let requestId = 10;
    const ack = async (workflowId: string) => {
      requestId += 1;
      const id = requestId;
      lines.push({
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { workflow_ids: [workflowId] },
          name: "inbox_ack",
        },
      });
      const response = await waitFor(`the inbox_ack answer ${id}`, () =>
        written.find((payload) => (payload as { id?: number }).id === id)
      );
      return JSON.parse(
        (response as { result: { content: { text: string }[] } }).result
          .content[0]?.text ?? "{}"
      ) as { acknowledged: { workflowId: string }[]; refused: unknown[] };
    };
    // The phone dials out for its stream: the only way anything reaches it.
    await waitFor("the phone's stream request through the TLS front", () =>
      frontRequests.some((path) => path.endsWith("/sessions/ra2-phone/inbox"))
        ? true
        : undefined
    );

    // 1. Receive and ACK over https.
    const first = await sendToPhone("one");
    await waitFor("the first message on the phone's channel", () =>
      channel().some((entry) => entry.params.content.includes(first))
        ? true
        : undefined
    );
    expect(await ack(first)).toMatchObject({
      acknowledged: [{ workflowId: first }],
      refused: [],
      workResultCompleted: false,
    });
    const acked = await waitFor("the first ACK recorded", async () => {
      const current = await statusOf(first);
      return current.acknowledgedAt ? current : undefined;
    });
    // ACK is not completion.
    expect(acked.workResultCompleted).toBe(false);

    // 2. A second message is received and left unacknowledged.
    const second = await sendToPhone("two");
    await waitFor("the second message on the phone's channel", () =>
      channel().some((entry) => entry.params.content.includes(second))
        ? true
        : undefined
    );

    // 3. The phone's network drops; a third message is accepted meanwhile.
    front.stop(true);
    const third = await sendToPhone("three");
    await waitFor(
      "the third message accepted into the phone's inbox",
      async () => {
        const current = await statusOf(third);
        return current.deliveredAt ? current : undefined;
      }
    );
    expect(
      channel().some((entry) => entry.params.content.includes(third))
    ).toBe(false);

    // 4. The network returns: the phone reconnects from its Last-Event-ID and
    // gets the third message once; the second is not replayed.
    front = tlsFront({ ...ca, port: tlsPort, upstreamPort: port });
    fronts.push(front);
    await waitFor(
      "the third message after the reconnect",
      () =>
        channel().some((entry) => entry.params.content.includes(third))
          ? true
          : undefined,
      60_000
    );
    const contents = channel().map((entry) => entry.params.content);
    for (const workflowId of [first, second, third]) {
      expect(
        contents.filter((content) => content.includes(workflowId)).length
      ).toBe(1);
    }
    // The first stream started without a cursor; the one that delivered the
    // third message resumed after the second (a sequence number, ids only).
    expect(frontResumes[0]).toBeNull();
    const resumedFrom = Number(frontResumes.at(-1));
    expect(resumedFrom).toBeGreaterThanOrEqual(2);
    expect(channelIndex(written, second)).toBeLessThan(
      channelIndex(written, third)
    );

    // 5. Another process of the session (`loop a2a`), late in the token's
    // life, refreshes it; the connect process picks up the new token, and
    // the old one is denied.
    const before = readA2ASessionCredential(credentialPath);
    const late = (TOKEN_TTL_SECONDS - 4 * 60) * 1000;
    await expect(
      runA2ACommand(
        [
          "a2a",
          "status",
          "--as",
          PHONE,
          "--message-id",
          "ra2-not-mine",
          "--trust-file",
          ca.caFile,
        ],
        { env: phoneEnv, nowMs: () => Date.now() + late }
      )
    ).rejects.toThrow("not-found");
    const after = readA2ASessionCredential(credentialPath);
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(after?.token).not.toBe(before?.token);
    const stale = await fetch(
      `${origin}${a2aV2MessageStatusPath(ROUTE, first)}`,
      {
        headers: { authorization: `Bearer ${before?.token}` },
        tls: { ca: readFileSync(ca.caFile, "utf8") },
      } as RequestInit
    );
    expect(stale.status).toBe(401);
    // The ACKs, on the refreshed token.
    expect(
      (await ack(second)).acknowledged.map((entry) => entry.workflowId)
    ).toEqual([second]);
    expect(
      (await ack(third)).acknowledged.map((entry) => entry.workflowId)
    ).toEqual([third]);
    for (const workflowId of [second, third]) {
      await waitFor(`${workflowId} acknowledged`, async () => {
        const current = await statusOf(workflowId);
        return current.acknowledgedAt ? current : undefined;
      });
    }
    // Everything reached the phone by its stream: its mailbox is untouched.
    expect(existsSync(mailboxOf(PHONE))).toBe(false);

    // 6. The session ends: the lease is released.
    lines.end();
    const outcome = await connected;
    expect(outcome).toEqual({ end: { reason: "aborted" }, released: true });
  } finally {
    abort.abort();
    for (const front of fronts) {
      front.stop(true);
    }
    await running?.catch(() => undefined);
    rmSync(root, { force: true, recursive: true });
  }
}, 240_000);

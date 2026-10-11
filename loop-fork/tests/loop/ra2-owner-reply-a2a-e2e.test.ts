// RA2: a supervisor replies to the owner over A2A only to a specific owner
// message, once.
//
// The real orchestration server (runLoopOrchestrationServer) on a local
// Temporal dev server and a task-owned Docker PostgreSQL, with its A2A V2
// plane. The owner and a supervisor send through `sendA2AMessage` with their
// static tokens over plaintext loopback. The owner's message opens a reply
// allowance only once the server accepted it (the ingress gate records
// nothing); the reply names it in `harness.dev/inReplyTo`. Nothing here
// reaches the operator's live state: every path is under one temp directory.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import {
  A2AClientError,
  resolveA2AClientEndpoint,
  sendA2AMessage,
} from "../../src/loop/a2a-session-client";
import { runLoopOrchestrationServer } from "../../src/loop/loop-orchestration-server";
import {
  OWNER_REPLY_LEDGER_FILE,
  OWNER_REPLY_ONLY,
} from "../../src/loop/orchestration-owner-messaging";
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
const OWNER = "supervisor:ra2-owner";
const SUP = "supervisor:ra2-desk";

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

test("over A2A a supervisor replies once to an accepted owner message, and to nothing else", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-owner-a2a-")));
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const serverHome = join(root, "server-home");
    mkdirSync(serverHome, { recursive: true });
    const port = freePort();
    const stateDir = join(root, "state");
    const mailboxOf = (id: string) =>
      join(root, "mail", `${id.slice("supervisor:".length)}.jsonl`);
    const serverConfigPath = join(root, "orchestration.json");
    writeFileSync(
      serverConfigPath,
      JSON.stringify({
        a2aV2: {
          databaseUrlEnv: "RA2_OWNER_DATABASE_URL",
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
          tenant: `tenant:ra2-owner-${randomUUID().slice(0, 8)}`,
          workflowIdFormat: "legacy",
        },
        address: temporal.address,
        buildId: "ra2-owner-reply-a2a-e2e.v1",
        // The parser requires one; roles decide every pair here.
        grants: [
          {
            from: OWNER,
            operations: ["receive"],
            principal: "principal:ra2-owner",
            to: SUP,
          },
        ],
        hostname: "127.0.0.1",
        identity: "loop-orchestration@ra2-owner",
        namespace: "default",
        port,
        schema: "loop-orchestration-server.v1",
        stateDir,
        supervisors: [
          {
            mailbox: mailboxOf(OWNER),
            principal: "principal:ra2-owner",
            role: { project: "all", repoKey: "estate", role: "owner" },
            supervisorId: OWNER,
            tokenEnv: "RA2_OWNER_TOKEN",
          },
          {
            mailbox: mailboxOf(SUP),
            principal: "principal:ra2-desk",
            role: {
              project: "loop",
              repoKey: "agents-collab",
              role: "supervisor",
            },
            supervisorId: SUP,
            tokenEnv: "RA2_DESK_TOKEN",
          },
        ],
        taskQueue: `ra2-owner-${randomUUID().slice(0, 8)}`,
      })
    );
    const tokens = {
      RA2_DESK_TOKEN: randomUUID(),
      RA2_OWNER_TOKEN: randomUUID(),
    };
    running = runLoopOrchestrationServer(
      serverConfigPath,
      {
        HOME: serverHome,
        LOOP_ORCHESTRATION_CONFIG: serverConfigPath,
        RA2_OWNER_DATABASE_URL: postgres.databaseUrl(),
        ...tokens,
      },
      {
        a2aV2EndpointRoots: supervisorEndpointRoots(serverHome),
        signal: abort.signal,
      }
    );
    const failed = running.then(
      () => "server stopped before it became ready",
      (error: unknown) =>
        `server failed: ${error instanceof Error ? error.message : String(error)}`
    );
    const deadline = Date.now() + 90_000;
    for (;;) {
      const body = (await fetch(`http://127.0.0.1:${port}/healthz`)
        .then((response) => response.json())
        .catch(() => undefined)) as
        | { a2aV2?: string; state?: string }
        | undefined;
      if (body?.state === "ready") {
        expect(body.a2aV2).toBe("ready");
        break;
      }
      const early = await Promise.race([
        failed,
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
      ]);
      if (early) {
        throw new Error(early);
      }
      if (Date.now() > deadline) {
        throw new Error("server never became ready");
      }
    }
    const clientConfig = join(root, "client.json");
    writeFileSync(
      clientConfig,
      JSON.stringify({
        a2aV2: { routePath: ROUTE },
        hostname: "127.0.0.1",
        port,
        supervisors: [
          { supervisorId: OWNER, tokenEnv: "RA2_OWNER_TOKEN" },
          { supervisorId: SUP, tokenEnv: "RA2_DESK_TOKEN" },
        ],
      })
    );
    const endpointFor = (id: string, tokenEnv: keyof typeof tokens) =>
      resolveA2AClientEndpoint(id, {
        env: {
          HOME: serverHome,
          LOOP_ORCHESTRATION_CONFIG: clientConfig,
          [tokenEnv]: tokens[tokenEnv],
        },
      });
    const owner = endpointFor(OWNER, "RA2_OWNER_TOKEN");
    const desk = endpointFor(SUP, "RA2_DESK_TOKEN");
    const reply = (messageId: string, inReplyTo?: string) =>
      sendA2AMessage(desk, {
        body: "done",
        ...(inReplyTo ? { inReplyTo } : {}),
        messageId,
        to: OWNER,
      }).then(
        (receipt) => receipt.accepted,
        (error: unknown) =>
          error instanceof A2AClientError ? error.code : String(error)
      );

    // Unprompted: refused with the named refusal.
    expect(await reply("desk-r-0")).toBe(OWNER_REPLY_ONLY);
    // Naming an owner message that was never accepted: refused.
    expect(await reply("desk-r-0", "owner-a2a-1")).toBe(OWNER_REPLY_ONLY);
    const sent = await sendA2AMessage(owner, {
      body: "please review",
      messageId: "owner-a2a-1",
      to: SUP,
    });
    expect(sent.accepted).toBe(true);
    const ledgerFile = join(stateDir, OWNER_REPLY_LEDGER_FILE);
    // biome-ignore lint/suspicious/noBitwiseOperators: file mode bits.
    expect(statSync(ledgerFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(ledgerFile, "utf8")).entries).toEqual([
      {
        acceptedAt: expect.any(Number),
        messageId: "owner-a2a-1",
        owner: OWNER,
        recipient: SUP,
        replies: [],
      },
    ]);
    // One reply; its retry is the same reply; a second one is refused.
    expect(await reply("desk-r-1", "owner-a2a-1")).toBe(true);
    expect(await reply("desk-r-1", "owner-a2a-1")).toBe(true);
    expect(await reply("desk-r-2", "owner-a2a-1")).toBe(OWNER_REPLY_ONLY);
    expect(
      JSON.parse(readFileSync(ledgerFile, "utf8")).entries[0].replies
    ).toEqual(["desk-r-1"]);
  } finally {
    abort.abort();
    await running?.catch(() => undefined);
    rmSync(root, { force: true, recursive: true });
  }
}, 240_000);

import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import { runLoopOrchestrationServer } from "../../src/loop/loop-orchestration-server";
import {
  OWNER_NOTIFICATION_PATH,
  OWNER_REPLY_ONLY,
} from "../../src/loop/orchestration-owner-messaging";
import {
  ENROLL_FAILURE_LIMIT,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";

/**
 * RA2 through the production composition (runLoopOrchestrationServer on a
 * real Temporal dev server): the V1 authority reads owner threads from the
 * server's own thread board, and the enroll route is limited by the peer
 * address Bun reports.
 */

const OWNER = "supervisor:owner";
const SUP = "supervisor:harness";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

let environment: TestWorkflowEnvironment | undefined;
afterAll(async () => {
  await environment?.teardown();
});

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

const fixture = (address: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-serve-")));
  roots.push(root);
  const signingKeyFile = join(root, "signing.pem");
  writeTokenSigningKey(signingKeyFile);
  const port = freePort();
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      address,
      buildId: "ra2-serve.v1",
      // The parser requires one; roles decide every pair here.
      grants: [
        {
          from: OWNER,
          operations: ["receive"],
          principal: "principal:owner",
          to: SUP,
        },
      ],
      hostname: "127.0.0.1",
      identity: "ra2-serve",
      namespace: "default",
      port,
      schema: "loop-orchestration-server.v1",
      stateDir: join(root, "state"),
      supervisors: [
        {
          mailbox: join(root, "mailbox", "supervisor_owner.jsonl"),
          principal: "principal:owner",
          role: { project: "all", repoKey: "estate", role: "owner" },
          supervisorId: OWNER,
          tokenEnv: "LOOP_RA2_OWNER_TOKEN",
        },
        {
          mailbox: join(root, "mailbox", "supervisor_harness.jsonl"),
          principal: "principal:harness",
          role: {
            project: "loop",
            repoKey: "agents-collab",
            role: "supervisor",
          },
          supervisorId: SUP,
          tokenEnv: "LOOP_RA2_HARNESS_TOKEN",
        },
      ],
      taskQueue: `ra2-serve-${randomUUID().slice(0, 8)}`,
      tokens: { signingKeyFile },
    }),
    { mode: 0o600 }
  );
  return {
    configPath,
    env: {
      LOOP_RA2_HARNESS_TOKEN: randomUUID(),
      LOOP_RA2_OWNER_TOKEN: randomUUID(),
    },
    port,
  };
};

const waitReady = async (port: number, running: Promise<void>) => {
  const failed = running.then(
    () => "stopped",
    (error: unknown) =>
      `failed: ${error instanceof Error ? error.message : String(error)}`
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = (await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.json())
      .catch(() => undefined)) as { state?: string } | undefined;
    if (body?.state === "ready") {
      return;
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
};

test("a supervisor replies to the owner only on the owner's thread; enroll is limited per peer", async () => {
  environment ??= await TestWorkflowEnvironment.createLocal();
  const f = fixture(environment.address);
  const stop = new AbortController();
  const running = runLoopOrchestrationServer(f.configPath, f.env, {
    signal: stop.signal,
  });
  try {
    await waitReady(f.port, running);
    const send = async (from: string, to: string, threadId: string) => {
      const id = `ra2-${randomUUID().slice(0, 8)}`;
      const response = await fetch(
        `http://127.0.0.1:${f.port}/api/v1/supervisor-messages/receive`,
        {
          body: JSON.stringify({
            input: {
              artifactRefs: [],
              body: "ra2",
              dedupeKey: id,
              from,
              messageId: id,
              policy: {
                claimTimeoutMs: 60_000,
                escalationTimeoutMs: 120_000,
                maxDeliveryAttempts: 3,
                retryDelayMs: 1000,
              },
              receivedAt: new Date().toISOString(),
              threadId,
              to,
            },
            messageKind: "informational",
            requestId: `receive-${id}`,
          }),
          headers: {
            authorization: `Bearer ${
              from === OWNER
                ? f.env.LOOP_RA2_OWNER_TOKEN
                : f.env.LOOP_RA2_HARNESS_TOKEN
            }`,
            "content-type": "application/json",
          },
          method: "POST",
        }
      );
      return { body: await response.json(), status: response.status };
    };
    const refused = await send(SUP, OWNER, "thread-1");
    expect(refused).toEqual({
      body: {
        error: {
          code: OWNER_REPLY_ONLY,
          message: expect.stringContaining("attention-os interaction"),
          notifyVia: OWNER_NOTIFICATION_PATH,
        },
      },
      status: 403,
    });
    expect((await send(OWNER, SUP, "thread-1")).status).toBe(200);
    expect((await send(SUP, OWNER, "thread-1")).status).toBe(200);
    expect((await send(SUP, OWNER, "thread-2")).status).toBe(403);

    const enroll = () =>
      fetch(`http://127.0.0.1:${f.port}/api/v1/tokens/enroll`, {
        body: JSON.stringify({ code: "A".repeat(43) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    for (let attempt = 0; attempt < ENROLL_FAILURE_LIMIT; attempt += 1) {
      expect((await enroll()).status).toBe(401);
    }
    const limited = await enroll();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally {
    stop.abort();
    await running.catch(() => undefined);
  }
}, 120_000);

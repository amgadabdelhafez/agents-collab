// Bind first: `loop orchestration serve` opens its port before anything that
// can wait on the world outside the process.
//
// The 2026-10-11 outage: under launchd the server never opened
// 127.0.0.1:7321. `runLoopOrchestrationServer` ran its first reconcile before
// `serve()`, the mailbox reconciler read a mailbox under ~/Documents with
// readFileSync, and macOS parked that open behind a Documents privacy (TCC)
// prompt that every new ad-hoc-signed build raises again. The event loop
// froze; nothing listened.
//
// Each server here runs in its own process (tests/support/
// orchestration-startup-child.ts), as launchd runs it, so a frozen server is
// observed from outside instead of freezing the test. A FIFO stands in for
// the parked open (tests/support/fifo.ts): an async read waits on it, while
// readFileSync freezes the event loop (proven in mailbox-file-access.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
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
import { listen, type Subprocess, serve, spawn } from "bun";
import { MAILBOX_PRIVACY_HINT } from "../../src/loop/mailbox-file-access";
import { createRunManifest, writeRunManifest } from "../../src/loop/run-state";
import { mailboxCursorPathFor } from "../../src/loop/supervisor-mailbox-cursor";
import { makeFifo, releaseFifo } from "../support/fifo";

const CHILD = join(
  import.meta.dir,
  "../support/orchestration-startup-child.ts"
);
const HEALTH_SCHEMA = "loop-orchestration-health.v1";
const STARTUP_PHASES = [
  "path-check",
  "a2a-v2-plane",
  "temporal-connect",
  "a2a-v2-service",
  "runtime-host",
  "first-reconcile",
];

const roots: string[] = [];
const fifos: string[] = [];
const cleanups: (() => void)[] = [];
let environment: TestWorkflowEnvironment | undefined;
const temporal = async (): Promise<TestWorkflowEnvironment> => {
  environment ??= await TestWorkflowEnvironment.createLocal();
  return environment;
};

afterAll(async () => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  for (const fifo of fifos) {
    if (existsSync(fifo)) {
      await releaseFifo(fifo).catch(() => false);
    }
  }
  await environment?.teardown();
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
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

/**
 * A TCP listener that accepts every connection and never answers a byte:
 * a Temporal frontend or a PostgreSQL that is up at the socket level and
 * dead above it.
 */
const blackHole = (): { address: string; port: number } => {
  const sockets: { end(): void }[] = [];
  const listener = listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: () => undefined,
      open: (socket) => {
        sockets.push(socket);
      },
    },
  });
  cleanups.push(() => {
    for (const socket of sockets) {
      socket.end();
    }
    listener.stop(true);
  });
  return { address: `127.0.0.1:${listener.port}`, port: listener.port };
};

const fixture = (input: {
  a2aV2?: boolean;
  address: string;
  manifest?: "fifo" | "file";
  parked?: "fifo" | "file";
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-bind-")));
  roots.push(root);
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  if (input.manifest === "fifo") {
    makeFifo(manifestPath);
    fifos.push(manifestPath);
  } else {
    writeRunManifest(
      manifestPath,
      createRunManifest({
        codexThreadId: "thread-a",
        cwd: root,
        mode: "paired",
        pid: process.pid,
        primaryAgent: "codex",
        repoId: "repo-startup",
        runId: "1",
        state: "working",
        tmuxPaneRight: "%2",
        tmuxPaneRightAgent: "codex",
      })
    );
  }
  for (const directory of ["harvto", "parked", "ready"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const parkedMailbox = join(root, "parked", "supervisor_parked.jsonl");
  if (input.parked === "fifo") {
    makeFifo(parkedMailbox);
    fifos.push(parkedMailbox);
  }
  const readyMailbox = join(root, "ready", "supervisor_ready.jsonl");
  const port = freePort();
  const configPath = join(root, "config.json");
  const value = {
    ...(input.a2aV2
      ? {
          a2aV2: {
            databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
            endpointRef: "endpoint:codex-app-server",
            policy: {
              claimTimeoutMs: 60_000,
              escalationTimeoutMs: 120_000,
              maxDeliveryAttempts: 3,
              retryDelayMs: 1000,
            },
            principal: "principal:harness",
            recipient: "supervisor:harness",
            resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
            routePath: "/a2a/v2",
            sessionTtlMs: 60_000,
            tenant: "tenant:startup",
            workflowIdFormat: "legacy",
          },
        }
      : {}),
    address: input.address,
    buildId: "startup-bind-first.v1",
    grants: [
      {
        from: "supervisor:harvto",
        operations: ["receive"],
        principal: "principal:harvto",
        to: "supervisor:ready",
      },
      {
        from: "supervisor:harvto",
        operations: ["claim", "acknowledge"],
        principal: "principal:ready",
        to: "supervisor:ready",
      },
    ],
    hostname: "127.0.0.1",
    identity: "startup-bind-first",
    namespace: "default",
    port,
    schema: "loop-orchestration-server.v1",
    stateDir: join(root, "state"),
    supervisors: [
      {
        manifestPath,
        principal: "principal:harness",
        seat: "codex",
        supervisorId: "supervisor:harness",
        tokenEnv: "LOOP_SB_HARNESS_TOKEN",
      },
      {
        mailbox: join(root, "harvto", "supervisor_harvto.jsonl"),
        principal: "principal:harvto",
        supervisorId: "supervisor:harvto",
        tokenEnv: "LOOP_SB_HARVTO_TOKEN",
      },
      {
        mailbox: parkedMailbox,
        principal: "principal:parked",
        supervisorId: "supervisor:parked",
        tokenEnv: "LOOP_SB_PARKED_TOKEN",
      },
      {
        mailbox: readyMailbox,
        principal: "principal:ready",
        supervisorId: "supervisor:ready",
        tokenEnv: "LOOP_SB_READY_TOKEN",
      },
    ],
    taskQueue: `startup-bind-${randomUUID().slice(0, 8)}`,
  };
  writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  return {
    configPath,
    env: {
      LOOP_A2A_V2_RESULT_GRAPH_KEY: randomBytes(32).toString("hex"),
      LOOP_SB_HARNESS_TOKEN: randomUUID(),
      LOOP_SB_HARVTO_TOKEN: randomUUID(),
      LOOP_SB_PARKED_TOKEN: randomUUID(),
      LOOP_SB_READY_TOKEN: randomUUID(),
    } as Record<string, string>,
    manifestPath,
    parkedMailbox,
    port,
    readyMailbox,
    root,
  };
};

type Fixture = ReturnType<typeof fixture>;

interface ServerProcess {
  child: Subprocess<"ignore", "ignore", "pipe">;
  lines: string[];
  /** When the child logged that it is calling runLoopOrchestrationServer. */
  startedAt: () => number | undefined;
  stop: () => Promise<number | null>;
}

const startServer = (
  f: Fixture,
  extraEnv: Record<string, string> = {}
): ServerProcess => {
  const lines: string[] = [];
  let startedAt: number | undefined;
  const child = spawn([process.execPath, CHILD, f.configPath], {
    env: { ...process.env, ...f.env, ...extraEnv },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
  });
  (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stderr) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (part === "[child] starting server") {
          startedAt = Date.now();
        }
        lines.push(part);
      }
    }
  })().catch(() => undefined);
  const stop = async (): Promise<number | null> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return child.exitCode;
    }
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
    return child.exitCode;
  };
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  return { child, lines, startedAt: () => startedAt, stop };
};

const waitFor = async <T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
  everyMs = 50
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};

const healthz = async (
  port: number
): Promise<{ body: Record<string, unknown>; status: number }> => {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(500),
  });
  return {
    body: (await response.json()) as Record<string, unknown>,
    status: response.status,
  };
};

const healthzOrUndefined = (port: number) =>
  healthz(port).catch(() => undefined);

const waitReady = (f: Fixture, server: ServerProcess, timeoutMs = 60_000) =>
  waitFor(
    "the server to report ready",
    async () => {
      if (server.child.exitCode !== null) {
        throw new Error(
          `server exited (${server.child.exitCode}):\n${server.lines.join("\n")}`
        );
      }
      const health = await healthzOrUndefined(f.port);
      return health?.body.state === "ready" ? health : undefined;
    },
    timeoutMs
  );

const startupLines = (server: ServerProcess) =>
  server.lines.filter((line) => line.startsWith("orchestration startup: "));

/** A V1 message from harvto to the mailbox-only `ready` recipient. */
const sendToReady = async (f: Fixture, id: string): Promise<string> => {
  const response = await fetch(
    `http://127.0.0.1:${f.port}/api/v1/supervisor-messages/receive`,
    {
      body: JSON.stringify({
        input: {
          artifactRefs: [],
          body: "bind-first V1 keeps working",
          dedupeKey: id,
          from: "supervisor:harvto",
          messageId: id,
          policy: {
            claimTimeoutMs: 60_000,
            escalationTimeoutMs: 120_000,
            maxDeliveryAttempts: 3,
            retryDelayMs: 1000,
          },
          receivedAt: new Date().toISOString(),
          threadId: `thread-${id}`,
          to: "supervisor:ready",
        },
        messageKind: "question",
        requestId: `receive-${id}`,
      }),
      headers: {
        authorization: `Bearer ${f.env.LOOP_SB_HARVTO_TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  expect(response.status).toBe(200);
  return await waitFor("the message to reach the ready mailbox", () => {
    if (!existsSync(f.readyMailbox)) {
      return undefined;
    }
    for (const line of readFileSync(f.readyMailbox, "utf8").split("\n")) {
      if (line.includes(id)) {
        return (JSON.parse(line) as { idempotencyKey: string }).idempotencyKey;
      }
    }
    return undefined;
  });
};

const messagePhase = async (
  f: Fixture,
  messageId: string
): Promise<string | undefined> => {
  const response = await fetch(
    `http://127.0.0.1:${f.port}/api/v1/supervisor-threads`,
    { headers: { authorization: `Bearer ${f.env.LOOP_SB_HARVTO_TOKEN}` } }
  );
  const body = (await response.json()) as {
    data: {
      threads: { messages: { item: { messageId: string; phase: string } }[] }[];
    };
  };
  return body.data.threads
    .flatMap((thread) => thread.messages)
    .find((message) => message.item.messageId === messageId)?.item.phase;
};

/** The recipient acknowledges by its cursor; the reconciler carries it on. */
const acknowledgeByCursor = (f: Fixture, idempotencyKey: string) =>
  writeFileSync(
    mailboxCursorPathFor(f.readyMailbox),
    JSON.stringify({
      consumedAt: new Date().toISOString(),
      consumedIdempotencyKeys: [idempotencyKey],
      schema: "supervisor-mailbox-cursor.v1",
    })
  );

describe("a parked mailbox open never stops the server from listening", () => {
  for (const variant of ["injected hung reader", "real FIFO"] as const) {
    test(`${variant}: /healthz answers within 1 s, the reader was entered once, the other binding still reconciles, and the count is 1`, async () => {
      const { address } = await temporal();
      const f = fixture({
        address,
        parked: variant === "real FIFO" ? "fifo" : "file",
      });
      const trace = join(f.root, "hung.trace");
      const server = startServer(f, {
        LOOP_TEST_STARTUP_BOUNDS: JSON.stringify({ fileAccessMs: 1500 }),
        ...(variant === "injected hung reader"
          ? {
              LOOP_TEST_HUNG_MAILBOX: f.parkedMailbox,
              LOOP_TEST_HUNG_TRACE: trace,
            }
          : {}),
      });
      try {
        const startedAt = await waitFor(
          "the child to start the server",
          () => server.startedAt(),
          20_000,
          5
        );
        const first = await waitFor(
          "the first /healthz answer",
          () => healthzOrUndefined(f.port),
          5000,
          20
        );
        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(first.status).toBe(503);
        expect(first.body).toMatchObject({
          schema: HEALTH_SCHEMA,
          state: "starting",
        });
        expect(STARTUP_PHASES).toContain(first.body.phase as string);

        const ready = await waitReady(f, server);
        expect(ready.status).toBe(200);
        expect(ready.body).toEqual({
          a2aV2: "off",
          notEnrolledCount: 0,
          schema: HEALTH_SCHEMA,
          state: "ready",
          unreadableBindingCount: 1,
        });

        // The other mailbox binding reconciles while the parked one waits:
        // its recipient's own acknowledgment reaches the workflow.
        const id = `bind-first-${randomUUID().slice(0, 8)}`;
        const key = await sendToReady(f, id);
        acknowledgeByCursor(f, key);
        await waitFor("the acknowledgment to reach the workflow", async () =>
          (await messagePhase(f, id)) === "acknowledged" ? true : undefined
        );

        // One parked open, logged once with its path and the hint, never
        // re-entered by the passes since (one every 250 ms).
        const parkedLines = server.lines.filter(
          (line) =>
            line.includes(f.parkedMailbox) &&
            line.includes(MAILBOX_PRIVACY_HINT) &&
            line.includes("is unreadable: no answer within 1500ms")
        );
        expect(parkedLines).toHaveLength(1);
        if (variant === "injected hung reader") {
          expect(readFileSync(trace, "utf8")).toBe("entered\n");
        } else {
          // A reader is parked on the FIFO: its write end opens at once.
          expect(await releaseFifo(f.parkedMailbox)).toBe(true);
        }
        expect((await healthz(f.port)).body.unreadableBindingCount).toBe(1);
      } finally {
        expect(await server.stop()).toBe(0);
      }
    }, 120_000);
  }

  test("a run manifest parked behind a prompt: path-check passes its deadline, the binding routes nowhere, V1 is ready", async () => {
    const { address } = await temporal();
    const f = fixture({ address, manifest: "fifo", parked: "file" });
    const server = startServer(f, {
      LOOP_TEST_STARTUP_BOUNDS: JSON.stringify({ fileAccessMs: 500 }),
    });
    try {
      const ready = await waitReady(f, server);
      expect(ready.body).toMatchObject({
        state: "ready",
        unreadableBindingCount: 1,
      });
      expect(
        server.lines.filter(
          (line) =>
            line.includes(f.manifestPath) && line.includes(MAILBOX_PRIVACY_HINT)
        )
      ).toHaveLength(1);
      const id = `manifest-parked-${randomUUID().slice(0, 8)}`;
      await sendToReady(f, id);
      // The bridge reconciler and delivery passed the parked binding by.
      expect((await healthz(f.port)).body.state).toBe("ready");
    } finally {
      expect(await server.stop()).toBe(0);
    }
  }, 120_000);
});

describe("startup phases", () => {
  test("a black-hole Temporal address: the phase stays temporal-connect, a retry is logged, other routes answer 503 starting, and a stop ends it", async () => {
    const hole = blackHole();
    const f = fixture({ address: hole.address, parked: "file" });
    const server = startServer(f, {
      LOOP_TEST_STARTUP_BOUNDS: JSON.stringify({
        temporalConnectMs: 300,
        temporalRetryBaseMs: 100,
        temporalRetryMaxMs: 200,
      }),
    });
    try {
      await waitFor(
        "a temporal-connect retry",
        () =>
          server.lines.find((line) =>
            line.startsWith(
              "orchestration startup: temporal-connect attempt 2 failed"
            )
          ),
        20_000
      );
      const health = await healthz(f.port);
      expect(health).toEqual({
        body: {
          phase: "temporal-connect",
          schema: HEALTH_SCHEMA,
          state: "starting",
        },
        status: 503,
      });
      const retry = server.lines.find((line) =>
        line.startsWith("orchestration startup: temporal-connect attempt 1")
      );
      expect(retry).toMatch(
        /^orchestration startup: temporal-connect attempt 1 failed \(.*\); retrying in 100ms$/
      );
      const other = await fetch(
        `http://127.0.0.1:${f.port}/api/v1/supervisor-threads`,
        { headers: { authorization: `Bearer ${f.env.LOOP_SB_HARVTO_TOKEN}` } }
      );
      expect(other.status).toBe(503);
      expect(await other.json()).toEqual({ error: { code: "starting" } });
      // Still connecting a moment later: no phase advanced past it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await healthz(f.port)).body.phase).toBe("temporal-connect");
      const stopping = Date.now();
      expect(await server.stop()).toBe(0);
      expect(Date.now() - stopping).toBeLessThan(3000);
      expect(server.lines).toContain("[child] server stopped");
    } finally {
      await server.stop();
    }
  }, 60_000);

  test("a black-hole PostgreSQL: V2 is disabled start-failed by its deadline and V1 is ready and delivers", async () => {
    const { address } = await temporal();
    const hole = blackHole();
    const f = fixture({ a2aV2: true, address, parked: "file" });
    const server = startServer(f, {
      LOOP_A2A_V2_DATABASE_URL: `postgres://loop:never-logged-pw@127.0.0.1:${hole.port}/loop_a2a`,
      LOOP_TEST_PROBE_A2A_V2: "ready",
      LOOP_TEST_STARTUP_BOUNDS: JSON.stringify({ a2aV2ServiceMs: 1500 }),
    });
    try {
      const ready = await waitReady(f, server);
      expect(ready.body).toEqual({
        a2aV2: "disabled",
        a2aV2Reason: "start-failed",
        notEnrolledCount: 0,
        schema: HEALTH_SCHEMA,
        state: "ready",
        unreadableBindingCount: 0,
      });
      expect(server.lines.filter((line) => line.startsWith("A2A V2"))).toEqual([
        "A2A V2 disabled (start-failed): Supervisor A2A V2 service start did not finish within 1500ms. Fix the cause, then restart; V1 continues",
      ]);
      expect(startupLines(server)).toEqual([
        "orchestration startup: path-check",
        "orchestration startup: a2a-v2-plane",
        "orchestration startup: temporal-connect",
        "orchestration startup: a2a-v2-service",
        "orchestration startup: runtime-host",
        "orchestration startup: first-reconcile",
        "orchestration startup: ready",
      ]);
      await sendToReady(f, `v2-hole-${randomUUID().slice(0, 8)}`);
      expect(server.lines.join("\n")).not.toContain("never-logged-pw");
    } finally {
      expect(await server.stop()).toBe(0);
    }
  }, 120_000);

  test("not ready until one reconciliation pass has succeeded: a failing pass keeps it starting at first-reconcile", async () => {
    const { address } = await temporal();
    const f = fixture({ address, parked: "file" });
    // A directory where the run's bridge file belongs: every bridge
    // reconciliation pass fails (EISDIR) until it is removed.
    const bridgeFile = join(f.root, "run", "bridge.jsonl");
    mkdirSync(bridgeFile);
    const server = startServer(f);
    try {
      await waitFor("a failed reconciliation pass", () =>
        server.lines.find((line) =>
          line.startsWith("orchestration bridge reconciliation failed")
        )
      );
      // Several passes later it is still starting, on the same phase.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await healthz(f.port)).toEqual({
        body: {
          phase: "first-reconcile",
          schema: HEALTH_SCHEMA,
          state: "starting",
        },
        status: 503,
      });
      rmSync(bridgeFile, { recursive: true });
      const ready = await waitReady(f, server);
      expect(ready.body).toMatchObject({ state: "ready" });
      expect(startupLines(server).at(-1)).toBe("orchestration startup: ready");
    } finally {
      expect(await server.stop()).toBe(0);
    }
  }, 120_000);

  test("ready after every phase, logged in order before each begins", async () => {
    const { address } = await temporal();
    const f = fixture({ address, parked: "file" });
    const server = startServer(f);
    try {
      const ready = await waitReady(f, server);
      expect(ready.body).toEqual({
        a2aV2: "off",
        notEnrolledCount: 0,
        schema: HEALTH_SCHEMA,
        state: "ready",
        unreadableBindingCount: 0,
      });
      expect(startupLines(server)).toEqual([
        "orchestration startup: path-check",
        "orchestration startup: a2a-v2-plane",
        "orchestration startup: temporal-connect",
        "orchestration startup: runtime-host",
        "orchestration startup: first-reconcile",
        "orchestration startup: ready",
      ]);
      // The plane decision is logged inside its phase, before Temporal.
      const lines = server.lines;
      expect(
        lines.findIndex((line) => line.startsWith("A2A V2 off"))
      ).toBeGreaterThan(lines.indexOf("orchestration startup: a2a-v2-plane"));
      expect(
        lines.findIndex((line) => line.startsWith("A2A V2 off"))
      ).toBeLessThan(lines.indexOf("orchestration startup: temporal-connect"));
      const id = `phases-${randomUUID().slice(0, 8)}`;
      await sendToReady(f, id);
    } finally {
      expect(await server.stop()).toBe(0);
    }
  }, 120_000);
});

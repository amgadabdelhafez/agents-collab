// The compiled `loop` binary's own A2A V2 client, end to end.
//
// Every other A2A V2 test runs the client from source. On 2026-10-11 the
// installed binary's `loop a2a send` reported "send refused or the server is
// unavailable" for a message the live server had accepted and delivered (it
// reached the recipient's mailbox six seconds after the client gave up): the
// server answers a send only after its first delivery attempt, which took
// longer than the client's 10 s request budget. This file runs the BUILT
// binary for the server (`loop orchestration serve`) and for the client
// (`loop a2a send`, `status`, `ack`), each as its own process, so neither a
// bundle that differs from the source nor a slow send can pass unnoticed.
//
// It runs only when LOOP_COMPILED_BINARY names a built binary (`bun run
// test:compiled-a2a` builds one into a scratch directory and sets it). The
// server is a throwaway: a local Temporal dev server, a task-owned Docker
// PostgreSQL, free loopback ports, and configs, HOME and mailboxes under one
// temp directory; nothing reaches the operator's live state.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { type Subprocess, serve, spawn } from "bun";
import { DisposablePostgres } from "../support/disposable-postgres";

const BINARY = process.env.LOOP_COMPILED_BINARY?.trim() ?? "";
const enabled = BINARY !== "";

const ROUTE = "/a2a/v2";
const SENDER = "supervisor:compiled-sender";
/** Mailbox only: it never claims a session, so a send lands in its mailbox. */
const RECIPIENT = "supervisor:compiled-recipient";
const PRINCIPAL = "principal:compiled-control";
const TOKEN_ENV_OF: Record<string, string> = {
  [RECIPIENT]: "COMPILED_A2A_RECIPIENT_TOKEN",
  [SENDER]: "COMPILED_A2A_SENDER_TOKEN",
};
/**
 * How long the slow server takes to answer a send: past the 10 s budget the
 * r9b client gave a send, inside the one it has now.
 */
const SLOW_SEND_MS = 12_000;

let postgres: DisposablePostgres | undefined;
let temporal: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  if (!(isAbsolute(BINARY) && statSync(BINARY).isFile())) {
    throw new Error(
      `LOOP_COMPILED_BINARY must be an absolute path to a built loop binary: ${BINARY}`
    );
  }
  postgres = await DisposablePostgres.create();
  temporal = await TestWorkflowEnvironment.createLocal();
}, 180_000);

afterAll(async () => {
  await temporal?.teardown();
  await postgres?.close();
}, 60_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
};

interface Fixture {
  /** The config the server reads; the client reads its own copy. */
  configPath: string;
  env: Record<string, string>;
  mailboxOf(supervisorId: string): string;
  port: number;
  remove(): void;
  root: string;
  tokens: string[];
  /** A client config naming `port` as the server (a proxy in front of it). */
  writeClientConfig(port: number): string;
}

const fixture = (databaseUrl: string, temporalAddress: string): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "compiled-a2a-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const mailboxOf = (supervisorId: string) =>
    join(root, "mail", `${supervisorId.slice("supervisor:".length)}.jsonl`);
  const port = freePort();
  const pair = (from: string, to: string) => ({
    from,
    operations: ["acknowledge", "claim", "receive"],
    principal: PRINCIPAL,
    to,
  });
  const config = {
    a2aV2: {
      databaseUrlEnv: "COMPILED_A2A_DATABASE_URL",
      endpointRef: "endpoint:loop-run",
      notEnrolledBoundMs: 3000,
      policy: {
        claimTimeoutMs: 120_000,
        escalationTimeoutMs: 240_000,
        maxDeliveryAttempts: 20,
        retryDelayMs: 1000,
      },
      principal: PRINCIPAL,
      resultGraphKeyEnv: "COMPILED_A2A_RESULT_GRAPH_KEY",
      routePath: ROUTE,
      sessionTtlMs: 4000,
      tenant: `tenant:compiled-a2a-${randomUUID().slice(0, 8)}`,
      workflowIdFormat: "legacy",
    },
    address: temporalAddress,
    buildId: "compiled-binary-a2a.v1",
    grants: [pair(SENDER, RECIPIENT), pair(RECIPIENT, SENDER)],
    hostname: "127.0.0.1",
    identity: "loop-orchestration@compiled-a2a",
    namespace: "default",
    port,
    schema: "loop-orchestration-server.v1",
    stateDir: join(root, "state"),
    supervisors: [SENDER, RECIPIENT].map((supervisorId) => ({
      mailbox: mailboxOf(supervisorId),
      principal: PRINCIPAL,
      supervisorId,
      tokenEnv: TOKEN_ENV_OF[supervisorId],
    })),
    taskQueue: `compiled-a2a-${randomUUID().slice(0, 8)}`,
  };
  const configPath = join(root, "orchestration.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // Only what the binary needs: nothing of the operator's environment but
  // PATH (the binary's own child lookups) and TMPDIR.
  const env: Record<string, string> = {
    COMPILED_A2A_DATABASE_URL: databaseUrl,
    COMPILED_A2A_RESULT_GRAPH_KEY: randomBytes(32).toString("hex"),
    HOME: home,
    LOOP_ORCHESTRATION_CONFIG: configPath,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  const tokens: string[] = [];
  for (const tokenEnv of Object.values(TOKEN_ENV_OF)) {
    const token = randomUUID();
    env[tokenEnv] = token;
    tokens.push(token);
  }
  return {
    configPath,
    env,
    mailboxOf,
    port,
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
    tokens,
    writeClientConfig: (clientPort) => {
      const path = join(root, `client-${clientPort}.json`);
      writeFileSync(path, JSON.stringify({ ...config, port: clientPort }), {
        mode: 0o600,
      });
      return path;
    },
  };
};

/**
 * A session's environment: the server's, less the server's own secrets and
 * every other supervisor's token (the client refuses more than one).
 */
const sessionEnv = (
  f: Fixture,
  supervisorId: string,
  configPath: string
): Record<string, string> => {
  const withheld = new Set([
    "COMPILED_A2A_DATABASE_URL",
    "COMPILED_A2A_RESULT_GRAPH_KEY",
    ...Object.entries(TOKEN_ENV_OF)
      .filter(([id]) => id !== supervisorId)
      .map(([, tokenEnv]) => tokenEnv),
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(f.env).filter(([name]) => !withheld.has(name))
    ),
    LOOP_ORCHESTRATION_CONFIG: configPath,
  };
};

interface BinaryResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runBinary = async (
  args: string[],
  env: Record<string, string>,
  cwd: string
): Promise<BinaryResult> => {
  const child = spawn([BINARY, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `loop a2a ...` through the binary, against the server `configPath` names;
 * the parsed JSON on success. Neither stream ever carries a token.
 */
const a2a = async (
  f: Fixture,
  args: string[],
  configPath = f.configPath
): Promise<Record<string, unknown>> => {
  const as = args[args.indexOf("--as") + 1] ?? "";
  const result = await runBinary(
    ["a2a", ...args],
    sessionEnv(f, as, configPath),
    f.root
  );
  for (const token of f.tokens) {
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `loop a2a ${args[0]} exited ${result.exitCode}: ${result.stderr.trim()}`
    );
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

const mailboxWorkflowIds = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => String(JSON.parse(line).workflowId))
    : [];

const startServer = (f: Fixture) => {
  const server: Subprocess<"ignore", "ignore", "pipe"> = spawn(
    [BINARY, "orchestration", "serve", f.configPath],
    {
      cwd: f.root,
      env: f.env,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "ignore",
    }
  );
  let log = "";
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of server.stderr) {
      log += decoder.decode(chunk, { stream: true });
    }
  })();
  const ready = Promise.race([
    server.exited.then(
      (code) => `server exited (${code}) before it became ready:\n${log}`
    ),
    waitFor("the server to report ready", async () => {
      const response = await fetch(`http://127.0.0.1:${f.port}/healthz`).catch(
        () => undefined
      );
      const body = (await response?.json().catch(() => undefined)) as
        | { a2aV2?: string; state?: string }
        | undefined;
      return body?.state === "ready" && body.a2aV2 === "ready"
        ? "ready"
        : undefined;
    }),
  ]);
  return {
    log: () => log,
    ready,
    stop: async () => {
      server.kill("SIGTERM");
      const stopped = await Promise.race([
        server.exited.then(() => true),
        sleep(10_000).then(() => false),
      ]);
      if (!stopped) {
        server.kill("SIGKILL");
        await server.exited;
      }
      await drained.catch(() => undefined);
    },
  };
};

const HOP_HEADERS = ["connection", "content-length", "host"];

/**
 * A loopback proxy in front of the server that passes every request through
 * at once, so the server accepts and delivers a send as soon as it can, and
 * holds the answer to a send (a POST to a supervisor ingress) for `delayMs`:
 * a server whose send answers slowly, as the live one did.
 */
const slowSendProxy = (
  targetPort: number,
  delayMs: number
): ReturnType<typeof serve> => {
  const ingress = `${ROUTE}/supervisors/`;
  return serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const name of HOP_HEADERS) {
        headers.delete(name);
      }
      const upstream = await fetch(
        `http://127.0.0.1:${targetPort}${url.pathname}${url.search}`,
        {
          ...(request.method === "GET"
            ? {}
            : { body: await request.arrayBuffer() }),
          headers,
          method: request.method,
          redirect: "manual",
        }
      );
      const body = await upstream.arrayBuffer();
      if (request.method === "POST" && url.pathname.startsWith(ingress)) {
        await sleep(delayMs);
      }
      const answer = new Headers(upstream.headers);
      for (const name of [...HOP_HEADERS, "content-encoding"]) {
        answer.delete(name);
      }
      return new Response(body, { headers: answer, status: upstream.status });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
};

const sendStatusAck = async (
  f: Fixture,
  messageId: string,
  sendConfigPath = f.configPath
) => {
  const bodyFile = join(f.root, `${messageId}.txt`);
  writeFileSync(bodyFile, `compiled binary smoke: ${messageId}`, {
    mode: 0o600,
  });
  // send: acceptance by the recipient's server, through the SDK client
  // bundled into the binary.
  const sent = await a2a(
    f,
    [
      "send",
      "--as",
      SENDER,
      "--to",
      RECIPIENT,
      "--body-file",
      bodyFile,
      "--message-id",
      messageId,
    ],
    sendConfigPath
  );
  expect(sent).toMatchObject({
    accepted: true,
    action: "send",
    messageId,
    to: RECIPIENT,
    workResultCompleted: false,
  });
  expect(sent.taskState).toBe("TASK_STATE_SUBMITTED");
  const workflowId = String(sent.workflowId);
  expect(workflowId).toStartWith("supervisor-message-workflow:v2:");

  // The session-less recipient's mailbox receives it, and the sender's
  // status records the delivery.
  await waitFor("the recipient's mail", () =>
    mailboxWorkflowIds(f.mailboxOf(RECIPIENT)).includes(workflowId)
      ? true
      : undefined
  );
  const delivered = await waitFor("the delivery recorded", async () => {
    const current = await a2a(f, [
      "status",
      "--as",
      SENDER,
      "--message-id",
      workflowId,
    ]);
    return current.deliveredAt ? current : undefined;
  });
  expect(delivered).toMatchObject({
    acknowledgedAt: null,
    action: "status",
    messageId: workflowId,
    to: RECIPIENT,
    workResultCompleted: false,
  });

  // ack: the recipient's read acknowledgement, never completion.
  expect(
    await a2a(f, ["ack", "--as", RECIPIENT, "--workflow", workflowId])
  ).toMatchObject({
    acknowledged: [{ phase: "acknowledged", workflowId }],
    action: "ack",
    refused: [],
    workResultCompleted: false,
  });
  const acknowledged = await a2a(f, [
    "status",
    "--as",
    SENDER,
    "--message-id",
    workflowId,
  ]);
  expect(acknowledged.acknowledgedAt).toBeString();
  expect(acknowledged.deliveredAt).toBeString();
  expect(acknowledged.workResultCompleted).toBe(false);
  return workflowId;
};

const withServer = async (
  run: (f: Fixture) => Promise<void>
): Promise<void> => {
  if (!(postgres && temporal)) {
    throw new Error("the throwaway server's dependencies did not start");
  }
  const f = fixture(postgres.databaseUrl(), temporal.address);
  const server = startServer(f);
  try {
    expect(await server.ready).toBe("ready");
    await run(f);
  } catch (error) {
    console.error(`[compiled-binary-a2a] server log:\n${server.log()}`);
    throw error;
  } finally {
    await server.stop();
    f.remove();
  }
};

test.skipIf(!enabled)(
  "the compiled loop binary sends, reads the status of and acknowledges an A2A V2 message through a throwaway server",
  async () => {
    await withServer(async (f) => {
      await sendStatusAck(f, `compiled-${randomUUID().slice(0, 8)}`);
    });
  },
  300_000
);

test.skipIf(!enabled)(
  "a send the server accepts but answers slowly (12 s, as the live server did) is reported accepted, never refused",
  async () => {
    await withServer(async (f) => {
      const proxy = slowSendProxy(f.port, SLOW_SEND_MS);
      try {
        const started = Date.now();
        await sendStatusAck(
          f,
          `compiled-slow-${randomUUID().slice(0, 8)}`,
          f.writeClientConfig(proxy.port as number)
        );
        // The answer really was held past the old budget.
        expect(Date.now() - started).toBeGreaterThan(SLOW_SEND_MS);
      } finally {
        proxy.stop(true);
      }
    });
  },
  300_000
);

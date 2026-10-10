// fix8: A2A V2 is on by default in `loop orchestration serve`, never at V1's
// expense.
//
//   off       — no a2aV2 section: one line naming `a2a-v2 init`, /healthz
//               `a2aV2: "off"`, V1 serves.
//   disabled  — a section whose ledger database is unset or unreachable: one
//               line, /healthz `a2aV2: "disabled"`, V1 serves and delivers.
//   env file  — the secrets `a2a-v2 init` wrote next to the config are read
//               (0600 only), under the process environment.
//   ready     — proven against real PostgreSQL in
//               loop-orchestration-server-postgres.test.ts.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import { withA2AV2EnvFile } from "../../src/loop/a2a-v2-env";
import {
  decideA2AV2Plane,
  parseLoopOrchestrationConfig,
  runLoopOrchestrationServer,
} from "../../src/loop/loop-orchestration-server";
import { createRunManifest, writeRunManifest } from "../../src/loop/run-state";

const SECRET_PASSWORD = "pw-never-logged-0123456789";
const UNREACHABLE_URL = `postgres://loop:${SECRET_PASSWORD}@127.0.0.1:1/loop_a2a`;

const roots: string[] = [];
afterAll(() => {
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

const fixture = (input: { address: string; a2aV2: boolean }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fix8-serve-")));
  roots.push(root);
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexThreadId: "thread-a",
      cwd: root,
      mode: "paired",
      pid: process.pid,
      primaryAgent: "codex",
      repoId: "repo-fix8",
      runId: "1",
      state: "working",
      tmuxPaneRight: "%2",
      tmuxPaneRightAgent: "codex",
    })
  );
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
            tenant: "tenant:fix8",
            workflowIdFormat: "legacy",
          },
        }
      : {}),
    address: input.address,
    buildId: "fix8-defaults.v1",
    grants: [
      {
        from: "supervisor:harvto",
        operations: ["receive"],
        principal: "principal:harvto",
        to: "supervisor:ai-cur",
      },
    ],
    hostname: "127.0.0.1",
    identity: "fix8-defaults",
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
        tokenEnv: "LOOP_FIX8_HARNESS_TOKEN",
      },
      {
        mailbox: join(root, "mailbox", "supervisor_harvto.jsonl"),
        principal: "principal:harvto",
        supervisorId: "supervisor:harvto",
        tokenEnv: "LOOP_FIX8_HARVTO_TOKEN",
      },
      {
        mailbox: join(root, "mailbox", "supervisor_ai-cur.jsonl"),
        principal: "principal:ai-cur",
        supervisorId: "supervisor:ai-cur",
        tokenEnv: "LOOP_FIX8_AI_CUR_TOKEN",
      },
    ],
    taskQueue: `fix8-defaults-${randomUUID().slice(0, 8)}`,
  };
  writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  return {
    configPath,
    env: {
      LOOP_A2A_V2_RESULT_GRAPH_KEY: randomBytes(32).toString("hex"),
      LOOP_FIX8_AI_CUR_TOKEN: randomUUID(),
      LOOP_FIX8_HARNESS_TOKEN: randomUUID(),
      LOOP_FIX8_HARVTO_TOKEN: randomUUID(),
    } as Record<string, string>,
    mailbox: join(root, "mailbox", "supervisor_ai-cur.jsonl"),
    port,
    root,
    value,
  };
};

describe("decideA2AV2Plane", () => {
  const withSection = () =>
    parseLoopOrchestrationConfig(
      fixture({ address: "127.0.0.1:1", a2aV2: true }).value
    );

  test("no section: off, with one line naming init and the config", async () => {
    const lines: string[] = [];
    const config = parseLoopOrchestrationConfig(
      fixture({ address: "127.0.0.1:1", a2aV2: false }).value
    );
    const decided = await decideA2AV2Plane({
      config,
      configPath: "/etc/loop/config.json",
      env: {},
      log: (line) => lines.push(line),
      probe: () => Promise.reject(new Error("must not probe")),
    });
    expect(decided.state).toBe("off");
    expect(lines).toEqual([
      "A2A V2 off: run loop orchestration a2a-v2 init /etc/loop/config.json",
    ]);
  });

  test("an unset database variable disables V2 and leaves a V1-only config", async () => {
    const lines: string[] = [];
    const decided = await decideA2AV2Plane({
      config: withSection(),
      configPath: "/etc/loop/config.json",
      env: {},
      log: (line) => lines.push(line),
      probe: () => Promise.reject(new Error("must not probe")),
    });
    expect(decided.state).toBe("disabled");
    expect(decided.config.a2aV2).toBeUndefined();
    expect(lines).toEqual([
      "A2A V2 disabled: ledger database variable LOOP_A2A_V2_DATABASE_URL is not set (neither in the environment nor in /etc/loop/a2a-v2.env); V1 continues",
    ]);
  });

  test("an unreachable database disables V2, and the line never carries the URL", async () => {
    const lines: string[] = [];
    const probed: string[] = [];
    const decided = await decideA2AV2Plane({
      config: withSection(),
      configPath: "/etc/loop/config.json",
      env: { LOOP_A2A_V2_DATABASE_URL: UNREACHABLE_URL },
      log: (line) => lines.push(line),
      probe: (url) => {
        probed.push(url);
        return Promise.resolve(false);
      },
    });
    expect(probed).toEqual([UNREACHABLE_URL]);
    expect(decided.state).toBe("disabled");
    expect(decided.config.a2aV2).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(
      "A2A V2 disabled: the ledger database named by LOOP_A2A_V2_DATABASE_URL is unreachable; V1 continues"
    );
    expect(lines.join("\n")).not.toContain(SECRET_PASSWORD);
    expect(lines.join("\n")).not.toContain("127.0.0.1:1");
  });

  test("a reachable database keeps the section: ready", async () => {
    const config = withSection();
    const decided = await decideA2AV2Plane({
      config,
      configPath: "/etc/loop/config.json",
      env: { LOOP_A2A_V2_DATABASE_URL: UNREACHABLE_URL },
      log: () => undefined,
      probe: () => Promise.resolve(true),
    });
    expect(decided).toEqual({ config, state: "ready" });
  });

  test("the real probe reports an unreachable database false, within its bound", async () => {
    const { probeA2AV2Database } = await import("../../src/loop/a2a-v2-env");
    const started = Date.now();
    expect(await probeA2AV2Database(UNREACHABLE_URL, 2000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("the env file next to the config", () => {
  const configIn = (root: string) => join(root, "config.json");

  test("fills only unset variables, from a 0600 file", () => {
    const root = mkdtempSync(join(tmpdir(), "fix8-envfile-"));
    roots.push(root);
    writeFileSync(
      join(root, "a2a-v2.env"),
      "# comment\nLOOP_A2A_V2_DATABASE_URL=postgres://from-file\nLOOP_A2A_V2_RESULT_GRAPH_KEY=file-key\n",
      { mode: 0o600 }
    );
    expect(
      withA2AV2EnvFile(configIn(root), {
        LOOP_A2A_V2_RESULT_GRAPH_KEY: "env-key",
      })
    ).toEqual({
      LOOP_A2A_V2_DATABASE_URL: "postgres://from-file",
      LOOP_A2A_V2_RESULT_GRAPH_KEY: "env-key",
    });
  });

  test("ignores, and says so, a group- or world-readable file and a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "fix8-envfile-"));
    roots.push(root);
    const path = join(root, "a2a-v2.env");
    writeFileSync(path, "LOOP_A2A_V2_DATABASE_URL=postgres://leaked\n", {
      mode: 0o600,
    });
    chmodSync(path, 0o640);
    const lines: string[] = [];
    expect(
      withA2AV2EnvFile(configIn(root), {}, (line) => lines.push(line))
    ).toEqual({});
    expect(lines).toEqual([
      `A2A V2 env file ignored: ${path} is readable by group or others; chmod 600 it and rotate what it holds`,
    ]);
    const other = mkdtempSync(join(tmpdir(), "fix8-envfile-"));
    roots.push(other);
    chmodSync(path, 0o600);
    symlinkSync(path, join(other, "a2a-v2.env"));
    expect(withA2AV2EnvFile(configIn(other), {}, () => undefined)).toEqual({});
  });

  test("absent: the environment is returned as is", () => {
    const root = mkdtempSync(join(tmpdir(), "fix8-envfile-"));
    roots.push(root);
    expect(existsSync(join(root, "a2a-v2.env"))).toBe(false);
    expect(withA2AV2EnvFile(configIn(root), { A: "1" })).toEqual({ A: "1" });
  });
});

describe("serve on a real Temporal dev server", () => {
  let environment: TestWorkflowEnvironment | undefined;
  afterAll(async () => {
    await environment?.teardown();
  });

  const health = async (port: number) =>
    (
      await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      })
    ).json();

  const startAndWait = async (
    f: ReturnType<typeof fixture>,
    env: Record<string, string>,
    signal: AbortSignal,
    probe?: (url: string) => Promise<boolean>
  ) => {
    const running = runLoopOrchestrationServer(f.configPath, env, {
      signal,
      ...(probe ? { probeA2AV2Database: probe } : {}),
    });
    const failed = running.then(
      () => "stopped",
      (error: unknown) =>
        `failed: ${error instanceof Error ? error.message : String(error)}`
    );
    const deadline = Date.now() + 30_000;
    let last: unknown;
    for (;;) {
      const body = (await health(f.port).catch(() => undefined)) as
        | { state?: string }
        | undefined;
      last = body ?? last;
      if (body?.state === "ready") {
        return { running };
      }
      const early = await Promise.race([
        failed,
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
      ]);
      if (early) {
        throw new Error(early);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `server never became ready; last /healthz: ${JSON.stringify(last)}`
        );
      }
    }
  };

  /** A V1 message from harvto to the mailbox-only ai-cur, through the service. */
  const sendV1 = async (f: ReturnType<typeof fixture>, id: string) => {
    const response = await fetch(
      `http://127.0.0.1:${f.port}/api/v1/supervisor-messages/receive`,
      {
        body: JSON.stringify({
          input: {
            artifactRefs: [],
            body: "fix8 V1 keeps working",
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
            to: "supervisor:ai-cur",
          },
          messageKind: "question",
          requestId: `receive-${id}`,
        }),
        headers: {
          authorization: `Bearer ${f.env.LOOP_FIX8_HARVTO_TOKEN}`,
          "content-type": "application/json",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (
        existsSync(f.mailbox) &&
        readFileSync(f.mailbox, "utf8").includes(id)
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the V1 message never reached the mailbox");
  };

  test("with a section and an unreachable ledger: V2 disabled, V1 serves and delivers, nothing logs the URL", async () => {
    environment ??= await TestWorkflowEnvironment.createLocal();
    const f = fixture({ address: environment.address, a2aV2: true });
    const errors = spyOn(console, "error");
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      ({ running } = await startAndWait(
        f,
        { ...f.env, LOOP_A2A_V2_DATABASE_URL: UNREACHABLE_URL },
        stop.signal
      ));
      expect(await health(f.port)).toEqual({
        a2aV2: "disabled",
        notEnrolledCount: 0,
        schema: "loop-orchestration-health.v1",
        state: "ready",
      });
      // The V2 route is not mounted.
      expect(
        (await fetch(`http://127.0.0.1:${f.port}/a2a/v2/assignment`)).status
      ).not.toBe(200);
      await sendV1(f, `fix8-disabled-${randomUUID().slice(0, 8)}`);
      const lines = errors.mock.calls.map(([line]) => String(line));
      expect(lines.filter((line) => line.startsWith("A2A V2"))).toEqual([
        "A2A V2 disabled: the ledger database named by LOOP_A2A_V2_DATABASE_URL is unreachable; V1 continues. Restart the service once it answers.",
      ]);
      expect(lines.join("\n")).not.toContain(SECRET_PASSWORD);
    } finally {
      stop.abort();
      await running?.catch(() => undefined);
      errors.mockRestore();
    }
  }, 120_000);

  test("without a section: V2 off with one line naming init, V1 serves and delivers", async () => {
    environment ??= await TestWorkflowEnvironment.createLocal();
    const f = fixture({ address: environment.address, a2aV2: false });
    const errors = spyOn(console, "error");
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      ({ running } = await startAndWait(f, f.env, stop.signal));
      expect(await health(f.port)).toMatchObject({
        a2aV2: "off",
        state: "ready",
      });
      await sendV1(f, `fix8-off-${randomUUID().slice(0, 8)}`);
      expect(
        errors.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.startsWith("A2A V2"))
      ).toEqual([
        `A2A V2 off: run loop orchestration a2a-v2 init ${f.configPath}`,
      ]);
    } finally {
      stop.abort();
      await running?.catch(() => undefined);
      errors.mockRestore();
    }
  }, 120_000);

  test("the ledger URL and result graph key are read from the 0600 env file next to the config", async () => {
    environment ??= await TestWorkflowEnvironment.createLocal();
    const f = fixture({ address: environment.address, a2aV2: true });
    const { LOOP_A2A_V2_RESULT_GRAPH_KEY: key, ...envWithoutKey } = f.env;
    writeFileSync(
      join(f.root, "a2a-v2.env"),
      `LOOP_A2A_V2_DATABASE_URL=${UNREACHABLE_URL}\nLOOP_A2A_V2_RESULT_GRAPH_KEY=${key}\n`,
      { mode: 0o600 }
    );
    const probed: string[] = [];
    const errors = spyOn(console, "error");
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      ({ running } = await startAndWait(
        f,
        envWithoutKey,
        stop.signal,
        (url) => {
          probed.push(url);
          return Promise.resolve(false);
        }
      ));
      // The file's URL was probed, and the file's key satisfied the
      // result graph key check that refuses start when it is missing.
      expect(probed).toEqual([UNREACHABLE_URL]);
      expect(await health(f.port)).toMatchObject({ a2aV2: "disabled" });
      expect(
        errors.mock.calls.map(([line]) => String(line)).join("\n")
      ).not.toContain(SECRET_PASSWORD);
    } finally {
      stop.abort();
      await running?.catch(() => undefined);
      errors.mockRestore();
    }
  }, 120_000);
});

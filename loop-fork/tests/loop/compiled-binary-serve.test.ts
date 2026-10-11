// The compiled `loop` binary serves on its own, wherever its build tree is.
//
// 2026-10-11: the compiled binary loaded the Temporal core bridge's native
// addon from the BUILD worktree's node_modules (the path is computed at run
// time from a `__dirname` baked in at compile time), and it was ad-hoc
// signed as `a.out` with a new cdhash every build, so macOS asked for
// Documents access again after every rebuild. This runs the BUILT binary's
// `orchestration serve` (whose Temporal worker loads the addon) against a
// local Temporal dev server and checks its code signature identifier.
//
// It runs only when LOOP_COMPILED_BINARY names a built binary. The
// self-containment check: build from a scratch copy of loop-fork, rename that
// copy's node_modules, then run this file with LOOP_COMPILED_BINARY set to
// the binary (scripts/test-hermetic.sh gives it a scratch HOME).

import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve, spawn, spawnSync } from "bun";

const BINARY = process.env.LOOP_COMPILED_BINARY?.trim() ?? "";
const enabled = BINARY !== "";

let environment: TestWorkflowEnvironment | undefined;
const roots: string[] = [];
afterAll(async () => {
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

test.skipIf(!enabled)("the built binary is signed as dev.harness.loop", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const shown = spawnSync(["codesign", "-dv", BINARY]);
  expect(shown.stderr.toString()).toContain("Identifier=dev.harness.loop");
});

test.skipIf(!enabled)(
  "the built binary's orchestration serve loads the Temporal core bridge and reports ready",
  async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "compiled-serve-")));
    roots.push(root);
    mkdirSync(join(root, "mailbox"));
    const port = freePort();
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        address: environment.address,
        buildId: "compiled-serve.v1",
        grants: [
          {
            from: "supervisor:sender",
            operations: ["receive"],
            principal: "principal:sender",
            to: "supervisor:solo",
          },
        ],
        hostname: "127.0.0.1",
        identity: "compiled-serve",
        namespace: "default",
        port,
        schema: "loop-orchestration-server.v1",
        stateDir: join(root, "state"),
        supervisors: [
          {
            mailbox: join(root, "mailbox", "supervisor_sender.jsonl"),
            principal: "principal:sender",
            supervisorId: "supervisor:sender",
            tokenEnv: "COMPILED_SERVE_TOKEN",
          },
          {
            mailbox: join(root, "mailbox", "supervisor_solo.jsonl"),
            principal: "principal:solo",
            supervisorId: "supervisor:solo",
            tokenEnv: "COMPILED_SERVE_TOKEN",
          },
        ],
        taskQueue: `compiled-serve-${randomUUID().slice(0, 8)}`,
      }),
      { mode: 0o600 }
    );
    let log = "";
    const server = spawn([BINARY, "orchestration", "serve", configPath], {
      env: { ...process.env, COMPILED_SERVE_TOKEN: randomUUID() },
      stderr: "pipe",
      stdout: "ignore",
    });
    (async () => {
      for await (const chunk of server.stderr) {
        log += new TextDecoder().decode(chunk);
      }
    })().catch(() => undefined);
    try {
      const deadline = Date.now() + 60_000;
      let state: unknown;
      while (Date.now() < deadline && state !== "ready") {
        if (server.exitCode !== null) {
          throw new Error(`server exited (${server.exitCode}):\n${log}`);
        }
        const body = (await fetch(`http://127.0.0.1:${port}/healthz`)
          .then((response) => response.json())
          .catch(() => undefined)) as { state?: unknown } | undefined;
        state = body?.state;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toBe("ready");
      expect(log).toContain("orchestration startup: ready");
      expect(log).not.toContain("No prebuilt module found");
    } finally {
      server.kill("SIGTERM");
      await server.exited;
    }
  },
  120_000
);

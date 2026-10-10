// fix8: `a2a-v2 init` against the real Docker daemon. It provisions a task-owned
// ledger (a unique container and volume name, a free loopback port), proves
// the container is published on 127.0.0.1 only and that the database in the
// env file answers, reruns it idempotently, and removes both afterwards.

import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import {
  parseA2AV2EnvFile,
  probeA2AV2Database,
} from "../../src/loop/a2a-v2-env";
import {
  A2AV2InitIncompleteError,
  defaultA2AV2InitDeps,
  runA2AV2Init,
} from "../../src/loop/a2a-v2-init";
import { privateDocker } from "../support/private-docker";

const NAME = `loop-a2a-ledger-test-${randomUUID().slice(0, 8)}`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "fix8-init-docker-")));

afterAll(async () => {
  await privateDocker({}, "rm", "--force", NAME).catch(() => "");
  await privateDocker({}, "volume", "rm", "--force", `${NAME}-data`).catch(
    () => ""
  );
  rmSync(root, { force: true, recursive: true });
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

test("init provisions a loopback-only ledger whose password lives only in the 0600 env file, and a rerun reuses it", async () => {
  const configPath = join(root, "config.json");
  const original = JSON.stringify({
    address: "127.0.0.1:7233",
    buildId: "fix8.v1",
    grants: [
      {
        from: "supervisor:a",
        operations: ["receive"],
        principal: "principal:a",
        to: "supervisor:b",
      },
    ],
    hostname: "127.0.0.1",
    identity: "fix8-docker",
    namespace: "default",
    port: 7399,
    schema: "loop-orchestration-server.v1",
    stateDir: join(root, "state"),
    supervisors: ["a", "b"].map((name) => ({
      mailbox: join(root, `supervisor_${name}.jsonl`),
      principal: `principal:${name}`,
      supervisorId: `supervisor:${name}`,
      tokenEnv: `LOOP_FIX8_${name.toUpperCase()}`,
    })),
    taskQueue: "fix8-docker",
  });
  writeFileSync(configPath, original, { mode: 0o600 });
  const port = freePort();
  const lines: string[] = [];
  const deps = {
    ...defaultA2AV2InitDeps(),
    log: (line: string) => lines.push(line),
  };
  const first = await runA2AV2Init(
    { configPath, containerName: NAME, ledgerPort: port },
    deps
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  // Mailbox-only supervisors: the ledger is ready, the section is not written.
  expect(first).toBeInstanceOf(A2AV2InitIncompleteError);
  expect(readFileSync(configPath, "utf8")).toBe(original);
  const envFile = join(root, "a2a-v2.env");
  expect(statSync(envFile).mode.toString(8).slice(-3)).toBe("600");
  const url = parseA2AV2EnvFile(readFileSync(envFile, "utf8")).get(
    "LOOP_A2A_V2_DATABASE_URL"
  );
  expect(url).toStartWith("postgres://loop:");
  expect(url).toEndWith(`@127.0.0.1:${port}/loop_a2a`);
  expect(await probeA2AV2Database(url as string)).toBe(true);
  // Published on loopback only, labelled, restarting with the daemon.
  expect(await privateDocker({}, "port", NAME, "5432/tcp")).toBe(
    `127.0.0.1:${port}`
  );
  expect(
    await privateDocker(
      {},
      "inspect",
      "--format",
      '{{index .Config.Labels "dev.loop.a2a-ledger"}} {{.HostConfig.RestartPolicy.Name}}',
      NAME
    )
  ).toBe("1 unless-stopped");
  // The password is in no argument Docker recorded for the container.
  const password = decodeURIComponent(new URL(url as string).password);
  const recorded = await privateDocker(
    {},
    "inspect",
    "--format",
    "{{json .Args}} {{json .Path}} {{json .Config.Cmd}}",
    NAME
  );
  expect(recorded).not.toContain(password);
  expect(lines.join("\n")).not.toContain(password);
  // Rerun after a stop: the same container, volume and password.
  await privateDocker({}, "stop", NAME);
  const second = await runA2AV2Init(
    { configPath, containerName: NAME, ledgerPort: port },
    deps
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  expect((second as A2AV2InitIncompleteError).result.ledger).toBe("reused");
  expect(
    parseA2AV2EnvFile(readFileSync(envFile, "utf8")).get(
      "LOOP_A2A_V2_DATABASE_URL"
    )
  ).toBe(url);
  expect(await probeA2AV2Database(url as string)).toBe(true);
}, 180_000);

// fix8: `a2a-v2 init` against the real Docker daemon. It provisions a task-owned
// ledger (a unique container and volume name, a free loopback port), proves
// the container is published on 127.0.0.1 only, that the database in the env
// file answers, and that the password reaches the container only through a
// read-only 0600 secret file (POSTGRES_PASSWORD_FILE): not argv, not the
// container's environment, nowhere in `docker inspect`. It reruns init
// idempotently, reuses a ledger the first fix8 build created (password in its
// environment) with the one line naming the recreate command, runs that
// command and proves the data and the password survive it. Everything it
// creates is removed afterwards.

import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SQL, serve } from "bun";
import {
  formatA2AV2EnvFile,
  parseA2AV2EnvFile,
  probeA2AV2Database,
} from "../../src/loop/a2a-v2-env";
import {
  A2A_V2_LEDGER_IMAGE,
  A2A_V2_LEDGER_PASSWORD_TARGET,
  A2AV2InitIncompleteError,
  defaultA2AV2InitDeps,
  legacyLedgerLine,
  runA2AV2Init,
} from "../../src/loop/a2a-v2-init";
import { privateDocker } from "../support/private-docker";

const NAME = `loop-a2a-ledger-test-${randomUUID().slice(0, 8)}`;
const LEGACY = `loop-a2a-ledger-legacy-${randomUUID().slice(0, 8)}`;
// The secret file is bind-mounted, so it must live where the Docker daemon
// can see it: colima and Docker Desktop share only the user's home, not the
// system temporary directory. This checkout is under it here; elsewhere set
// LOOP_TEST_DOCKER_BIND_ROOT to a shared directory.
const bindRoot =
  process.env.LOOP_TEST_DOCKER_BIND_ROOT ?? join(import.meta.dir, "..", "..");
const roots: string[] = [];
const newRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(bindRoot, ".a2a-ledger-test-")));
  roots.push(root);
  return root;
};

afterAll(async () => {
  for (const name of [NAME, LEGACY]) {
    await privateDocker({}, "rm", "--force", name).catch(() => "");
    await privateDocker({}, "volume", "rm", "--force", `${name}-data`).catch(
      () => ""
    );
  }
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

/** A live-shaped config: mailbox-only supervisors, no a2aV2 section. */
const writeConfig = (
  root: string
): { configPath: string; original: string } => {
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
  return { configPath, original };
};

/** Init with the real Docker; mailbox-only, so it ends incomplete. */
const init = async (
  configPath: string,
  containerName: string,
  ledgerPort: number,
  lines: string[]
): Promise<A2AV2InitIncompleteError> => {
  const outcome = await runA2AV2Init(
    { configPath, containerName, ledgerPort },
    { ...defaultA2AV2InitDeps(), log: (line: string) => lines.push(line) }
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(A2AV2InitIncompleteError);
  return outcome as A2AV2InitIncompleteError;
};

const envUrl = (envFile: string): string =>
  parseA2AV2EnvFile(readFileSync(envFile, "utf8")).get(
    "LOOP_A2A_V2_DATABASE_URL"
  ) as string;

// biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
const modeOf = (path: string) => statSync(path).mode & 0o777;

/** What Docker recorded for the container: environment and mounts. */
const recorded = async (name: string) => ({
  env: JSON.parse(
    await privateDocker({}, "inspect", "--format", "{{json .Config.Env}}", name)
  ) as string[],
  inspect: await privateDocker({}, "inspect", name),
  mounts: await privateDocker(
    {},
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}} rw={{.RW}}{{end}}{{end}}',
    name
  ),
});

const waitForAnswer = async (url: string): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await probeA2AV2Database(url, 2000)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the ledger never answered");
};

test("init provisions a loopback-only ledger whose password reaches the container only through a read-only 0600 secret file, and a rerun reuses it", async () => {
  const root = newRoot();
  const { configPath, original } = writeConfig(root);
  const port = freePort();
  const lines: string[] = [];
  await init(configPath, NAME, port, lines);
  // Mailbox-only supervisors: the ledger is ready, the section is not written.
  expect(readFileSync(configPath, "utf8")).toBe(original);
  const envFile = join(root, "a2a-v2.env");
  expect(modeOf(envFile)).toBe(0o600);
  const url = envUrl(envFile);
  expect(url).toStartWith("postgres://loop:");
  expect(url).toEndWith(`@127.0.0.1:${port}/loop_a2a`);
  expect(await probeA2AV2Database(url)).toBe(true);
  const password = decodeURIComponent(new URL(url).password);
  // The secret file: next to the config, 0600, the password alone.
  const passwordFile = join(root, `${NAME}.password`);
  expect(modeOf(passwordFile)).toBe(0o600);
  expect(readFileSync(passwordFile, "utf8")).toBe(password);
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
  // The container reads the password from the read-only mount; its
  // environment names the file, never the value, and nothing Docker
  // records for it (environment, argv, mounts, labels) holds the password.
  const record = await recorded(NAME);
  expect(record.env).toContain(
    `POSTGRES_PASSWORD_FILE=${A2A_V2_LEDGER_PASSWORD_TARGET}`
  );
  expect(
    record.env.filter((entry) => entry.startsWith("POSTGRES_PASSWORD="))
  ).toEqual([]);
  expect(record.mounts).toBe(`${A2A_V2_LEDGER_PASSWORD_TARGET} rw=false`);
  expect(record.inspect).not.toContain(password);
  expect(record.inspect).not.toContain(encodeURIComponent(password));
  expect(lines.join("\n")).not.toContain(password);
  // Rerun after a stop: the same container, volume, password and file.
  await privateDocker({}, "stop", NAME);
  const second = await init(configPath, NAME, port, lines);
  expect(second.result.ledger).toBe("reused");
  expect(envUrl(envFile)).toBe(url);
  expect(readFileSync(passwordFile, "utf8")).toBe(password);
  expect(await probeA2AV2Database(url)).toBe(true);
  expect(lines.some((line) => line.includes("POSTGRES_PASSWORD"))).toBe(false);
}, 180_000);

test("a ledger the first fix8 build created (password in its container environment) is reused with one line naming the recreate command, and that command keeps the data and the password", async () => {
  const root = newRoot();
  const { configPath } = writeConfig(root);
  const port = freePort();
  const password = randomBytes(24).toString("base64url");
  const url = `postgres://loop:${encodeURIComponent(password)}@127.0.0.1:${port}/loop_a2a`;
  const envFile = join(root, "a2a-v2.env");
  writeFileSync(
    envFile,
    formatA2AV2EnvFile(
      new Map([
        ["LOOP_A2A_V2_DATABASE_URL", url],
        ["LOOP_A2A_V2_RESULT_GRAPH_KEY", randomBytes(32).toString("base64url")],
      ])
    ),
    { mode: 0o600 }
  );
  // Exactly as f9a38faa created it: the password handed through the child
  // environment into the container's own.
  await privateDocker(
    { POSTGRES_PASSWORD: password },
    "run",
    "--detach",
    "--name",
    LEGACY,
    "--label",
    "dev.loop.a2a-ledger=1",
    "--restart",
    "unless-stopped",
    "--volume",
    `${LEGACY}-data:/var/lib/postgresql/data`,
    "--publish",
    `127.0.0.1:${port}:5432`,
    "--env",
    "POSTGRES_PASSWORD",
    "--env",
    "POSTGRES_USER=loop",
    "--env",
    "POSTGRES_DB=loop_a2a",
    A2A_V2_LEDGER_IMAGE
  );
  await waitForAnswer(url);
  // The defect being fixed, as a control: inspect shows the password.
  expect((await recorded(LEGACY)).inspect).toContain(password);
  const sql = new SQL(url);
  try {
    await sql`CREATE TABLE fix8_marker (id integer)`;
    await sql`INSERT INTO fix8_marker VALUES (8)`;
  } finally {
    await sql.close({ timeout: 0 });
  }

  // Init accepts it: reused as it is, one line, no password file.
  const lines: string[] = [];
  const reused = await init(configPath, LEGACY, port, lines);
  expect(reused.result.ledger).toBe("reused");
  expect(lines).toContain(legacyLedgerLine(LEGACY, configPath));
  expect(
    lines.filter((line) => line.includes("POSTGRES_PASSWORD"))
  ).toHaveLength(1);
  expect(existsSync(join(root, `${LEGACY}.password`))).toBe(false);
  expect(envUrl(envFile)).toBe(url);
  expect(lines.join("\n")).not.toContain(password);

  // The documented command: docker rm -f <name> && loop orchestration
  // a2a-v2 init <config>.
  await privateDocker({}, "rm", "--force", LEGACY);
  const recreatedLines: string[] = [];
  const recreated = await init(configPath, LEGACY, port, recreatedLines);
  expect(recreated.result.ledger).toBe("provisioned");
  expect(
    recreatedLines.some((line) => line.includes("POSTGRES_PASSWORD"))
  ).toBe(false);
  const record = await recorded(LEGACY);
  expect(record.inspect).not.toContain(password);
  expect(
    record.env.filter((entry) => entry.startsWith("POSTGRES_PASSWORD="))
  ).toEqual([]);
  expect(record.mounts).toBe(`${A2A_V2_LEDGER_PASSWORD_TARGET} rw=false`);
  expect(readFileSync(join(root, `${LEGACY}.password`), "utf8")).toBe(password);
  // Same URL and password, same volume: the data is still there.
  expect(envUrl(envFile)).toBe(url);
  await waitForAnswer(url);
  const after = new SQL(url);
  try {
    const rows: { id: number }[] = await after`SELECT id FROM fix8_marker`;
    expect([...rows]).toEqual([{ id: 8 }]);
  } finally {
    await after.close({ timeout: 0 });
  }
}, 240_000);

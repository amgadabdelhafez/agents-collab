import { expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  parseOrchestrationCommand,
  runOrchestrationCommand,
} from "../../src/loop/orchestration-command";
import {
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import { DisposablePostgres } from "../support/disposable-postgres";

const MESSAGE = `supervisor-message-workflow:v2:${"a".repeat(64)}`;

test("orchestration command resolves one config and invokes the server once", async () => {
  const runner = mock(async (_configPath: string) => undefined);
  const handled = await runOrchestrationCommand(
    ["orchestration", "serve", "config/orchestration.json"],
    runner
  );
  expect(handled).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner).toHaveBeenCalledWith(resolve("config/orchestration.json"));
});

test("orchestration command is isolated from ordinary Loop argv", async () => {
  const runner = mock(async (_configPath: string) => undefined);
  expect(await runOrchestrationCommand(["--tmux"], runner)).toBe(false);
  expect(runner).not.toHaveBeenCalled();
});

test("orchestration command refuses incomplete or ambiguous invocation", () => {
  const invalid = [
    ["orchestration"],
    ["orchestration", "start", "/tmp/config.json"],
    ["orchestration", "serve"],
    ["orchestration", "serve", "/tmp/config.json", "extra"],
    ["orchestration", "result-graph-id", "/tmp/config.json"],
    ["orchestration", "result-graph-id", "/tmp/config.json", MESSAGE, "x"],
  ];
  for (const argv of invalid) {
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "Usage: loop orchestration serve <config-path>"
    );
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "loop orchestration result-graph-id <config-path> <message-workflow-id>"
    );
  }
});

test("orchestration command parses the V2 recovery quarantine forms and refuses incomplete ones", () => {
  const config = resolve("config/orchestration.json");
  expect(
    parseOrchestrationCommand([
      "orchestration",
      "v2-quarantine",
      "config/orchestration.json",
      MESSAGE,
      "--reason",
      "start snapshot unreadable",
    ])
  ).toEqual({
    by: undefined,
    command: "v2-quarantine",
    configPath: config,
    reason: "start snapshot unreadable",
    workflowId: MESSAGE,
  });
  expect(
    parseOrchestrationCommand([
      "orchestration",
      "v2-quarantine-release",
      "config/orchestration.json",
      MESSAGE,
      "--by",
      "operator-b",
      "--reason",
      "fixed",
    ])
  ).toEqual({
    by: "operator-b",
    command: "v2-quarantine-release",
    configPath: config,
    reason: "fixed",
    workflowId: MESSAGE,
  });
  expect(
    parseOrchestrationCommand([
      "orchestration",
      "v2-quarantine-list",
      "config/orchestration.json",
    ])
  ).toEqual({ command: "v2-quarantine-list", configPath: config });
  const invalid = [
    ["orchestration", "v2-quarantine", "/tmp/c.json", MESSAGE],
    ["orchestration", "v2-quarantine", "/tmp/c.json", MESSAGE, "--reason"],
    ["orchestration", "v2-quarantine", "/tmp/c.json", MESSAGE, "--reason", ""],
    ["orchestration", "v2-quarantine", "/tmp/c.json", "--reason", "why"],
    [
      "orchestration",
      "v2-quarantine",
      "/tmp/c.json",
      MESSAGE,
      "--reason",
      "why",
      "--reason",
      "twice",
    ],
    [
      "orchestration",
      "v2-quarantine",
      "/tmp/c.json",
      MESSAGE,
      "--reason",
      "why",
      "--force",
    ],
    // A flag is never taken for the workflow id.
    [
      "orchestration",
      "v2-quarantine",
      "/tmp/c.json",
      "--reason",
      "--reason",
      "why",
    ],
    ["orchestration", "v2-quarantine-release", "/tmp/c.json", MESSAGE],
    ["orchestration", "v2-quarantine-list"],
    ["orchestration", "v2-quarantine-list", "/tmp/c.json", MESSAGE],
  ];
  for (const argv of invalid) {
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "loop orchestration v2-quarantine <config-path> <workflow-id> --reason <text> [--by <operator>]"
    );
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "loop orchestration v2-quarantine-release <config-path> <workflow-id> --reason <text> [--by <operator>]"
    );
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "loop orchestration v2-quarantine-list <config-path>"
    );
  }
});

/** An orchestration config for the v2-quarantine commands, in `root`. */
const writeQuarantineConfig = (
  root: string,
  deployment: string,
  a2aExtra: Record<string, unknown> = {}
): string => {
  const configPath = join(root, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: {
        databaseUrlEnv: "LOOP_CLI_A2A_V2_DATABASE_URL",
        endpointRef: "endpoint:local-a2a",
        policy: {
          claimTimeoutMs: 60_000,
          escalationTimeoutMs: 120_000,
          maxDeliveryAttempts: 3,
          retryDelayMs: 1000,
        },
        principal: "principal:harness",
        recipient: "supervisor:harness",
        routePath: "/a2a",
        sessionTtlMs: 3_600_000,
        tenant: "tenant:local",
        ...a2aExtra,
      },
      address: "127.0.0.1:9",
      buildId: "loop-orchestration.v1",
      grants: [
        {
          from: "supervisor:source",
          operations: ["receive"],
          principal: "principal:harness",
          to: "supervisor:harness",
        },
      ],
      hostname: "127.0.0.1",
      identity: "loop-orchestration@local",
      namespace: "default",
      port: 7321,
      schema: "loop-orchestration-server.v1",
      stateDir: join(root, "state"),
      supervisors: [
        {
          manifestPath: join(root, "manifest.json"),
          principal: "principal:harness",
          supervisorId: "supervisor:harness",
          tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
        },
      ],
      taskQueue: deployment,
    })
  );
  return configPath;
};

test("v2-quarantine records, lists and releases a quarantine in the configured deployment's PostgreSQL ledger, printing no secret", async () => {
  const postgres = await DisposablePostgres.create();
  const root = mkdtempSync(join(tmpdir(), "loop-orch-quarantine-"));
  const deployment = "loop-orchestration";
  const configPath = writeQuarantineConfig(root, deployment);
  const databaseUrl = postgres.databaseUrl();
  const env = { LOOP_CLI_A2A_V2_DATABASE_URL: databaseUrl };
  const fixture = supervisorMessageV2ReplayFixtures[0];
  if (!fixture) {
    throw new Error("missing V2 fixture");
  }
  const scope = fixture.expectedScope;
  // The config sets no workflow id format: the shipping default writes the
  // legacy id, which names no deployment.
  const workflowId = deriveSupervisorMessageV2LegacyWorkflowId(
    scope,
    fixture.input.dedupeKey
  );
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    databaseUrl,
    { buildId: "loop-orchestration.v1", deployment }
  );
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runOrchestrationCommand(
      ["orchestration", ...args],
      () => {
        throw new Error("the server must not start");
      },
      { env, write: (text) => lines.push(text) }
    );
  try {
    await ledger.migrate();
    await ledger.recordStartIntent(workflowId, scope, fixture.input);

    expect(await run("v2-quarantine-list", configPath)).toBe(true);
    expect(
      await run(
        "v2-quarantine",
        configPath,
        workflowId,
        "--reason",
        "start keeps failing"
      )
    ).toBe(true);
    const [entry] = await ledger.recoveryQuarantines();
    if (!entry) {
      throw new Error("the quarantine was not recorded");
    }
    // Who defaults to the operating-system user running the command.
    expect(entry).toEqual({
      at: entry.at,
      by: userInfo().username,
      reason: "start keeps failing",
      recipient: fixture.input.to,
      tenantId: scope.tenantId,
      workflowId,
    });
    expect(
      await run(
        "v2-quarantine",
        configPath,
        workflowId,
        "--reason",
        "again",
        "--by",
        "operator-z"
      )
    ).toBe(true);
    expect(await run("v2-quarantine-list", configPath)).toBe(true);
    expect(
      await run(
        "v2-quarantine-release",
        configPath,
        workflowId,
        "--reason",
        "cause fixed",
        "--by",
        "operator-b"
      )
    ).toBe(true);
    expect(await ledger.recoveryQuarantines()).toEqual([]);
    expect(lines).toEqual([
      "no quarantined V2 recovery records\n",
      `quarantined ${workflowId} for ${fixture.input.to} by ${entry.by} at ${entry.at}: start keeps failing\n`,
      `already quarantined ${workflowId} for ${fixture.input.to} by ${entry.by} at ${entry.at}: start keeps failing\n`,
      `${workflowId} for ${fixture.input.to} quarantined by ${entry.by} at ${entry.at}: start keeps failing\n`,
      `released ${workflowId} for ${fixture.input.to} (quarantined by ${entry.by} at ${entry.at}: start keeps failing)\n`,
    ]);
    const printed = lines.join("");
    expect(printed).not.toContain(databaseUrl);
    expect(printed).not.toContain(new URL(databaseUrl).password);

    // A record that is not this deployment's is refused, by id only.
    const unknown = `supervisor-message-workflow:v2:deployment:${"b".repeat(64)}`;
    const refused = await run(
      "v2-quarantine",
      configPath,
      unknown,
      "--reason",
      "x"
    ).then(
      () => "accepted",
      (error: Error) => error.message
    );
    expect(refused).toBe(
      `V2 workflow ${unknown} has no start intent recorded by this deployment`
    );
    // Without the database environment the command refuses before connecting.
    const missing = await runOrchestrationCommand(
      ["orchestration", "v2-quarantine-list", configPath],
      () => Promise.resolve(),
      { env: {}, write: (text) => lines.push(text) }
    ).then(
      () => "listed",
      (error: Error) => error.message
    );
    expect(missing).toBe(
      "missing orchestration A2A V2 database environment LOOP_CLI_A2A_V2_DATABASE_URL"
    );
    // An unreachable database is reported without its URL or credentials.
    const unreachable = new URL(databaseUrl);
    unreachable.port = "1";
    const offline = await runOrchestrationCommand(
      ["orchestration", "v2-quarantine-list", configPath],
      () => Promise.resolve(),
      {
        env: { LOOP_CLI_A2A_V2_DATABASE_URL: unreachable.toString() },
        write: (text) => lines.push(text),
      }
    ).then(
      () => "listed",
      (error: Error) => error.message
    );
    expect(offline).toBe("orchestration A2A V2 ledger is unavailable");
    // A refusal over the recorded workflow id format is the operator's to act
    // on: it is printed as the server prints it, never as "unavailable".
    const sql = new SQL(databaseUrl);
    await sql.connect();
    try {
      await sql`UPDATE loop_supervisor_message_v2_schema_marker SET value = 'future-format' WHERE name = 'workflow-id-format.v1'`;
    } finally {
      await sql.close({ timeout: 0 });
    }
    const unsupported = await run("v2-quarantine-list", configPath).then(
      () => "listed",
      (error: Error) => error.message
    );
    expect(unsupported).toBe(
      'orchestration A2A V2 ledger refused: V2 delivery ledger records workflow id format "future-format" (written by build loop-orchestration.v1), which this build does not support; it supports "legacy" and "deployment". Run a build that supports the recorded format'
    );
  } finally {
    await ledger.close();
    rmSync(root, { force: true, recursive: true });
    await postgres.close();
  }
}, 60_000);

test("v2-quarantine opens the ledger as the server does: the config's build and workflow id format", async () => {
  const postgres = await DisposablePostgres.create();
  const root = mkdtempSync(join(tmpdir(), "loop-orch-quarantine-format-"));
  const deployment = "loop-orchestration-deployment";
  const configPath = writeQuarantineConfig(root, deployment, {
    workflowIdFormat: "deployment",
  });
  const databaseUrl = postgres.databaseUrl();
  const fixture = supervisorMessageV2ReplayFixtures[0];
  if (!fixture) {
    throw new Error("missing V2 fixture");
  }
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runOrchestrationCommand(
      ["orchestration", ...args],
      () => {
        throw new Error("the server must not start");
      },
      {
        env: { LOOP_CLI_A2A_V2_DATABASE_URL: databaseUrl },
        write: (text) => lines.push(text),
      }
    );
  const sql = new SQL(databaseUrl);
  let ledger: PostgresSupervisorMessageV2DeliveryLedger | undefined;
  try {
    // On a fresh database the command records what the server's first
    // start would: the configured format, written by the configured build.
    expect(await run("v2-quarantine-list", configPath)).toBe(true);
    await sql.connect();
    expect(
      await sql`SELECT value, build_id FROM loop_supervisor_message_v2_schema_marker WHERE name = 'workflow-id-format.v1'`
    ).toEqual([{ build_id: "loop-orchestration.v1", value: "deployment" }]);
    // A deployment-format record of this deployment is quarantined by id.
    ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      {
        buildId: "loop-orchestration.v1",
        deployment,
        workflowIdFormat: "deployment",
      }
    );
    await ledger.migrate();
    const scope = fixture.expectedScope;
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      fixture.input.dedupeKey,
      deployment
    );
    await ledger.recordStartIntent(workflowId, scope, fixture.input);
    expect(
      await run(
        "v2-quarantine",
        configPath,
        workflowId,
        "--reason",
        "start keeps failing",
        "--by",
        "operator-a"
      )
    ).toBe(true);
    expect(
      (await ledger.recoveryQuarantines()).map((entry) => entry.workflowId)
    ).toEqual([workflowId]);
  } finally {
    await ledger?.close();
    await sql.close({ timeout: 0 });
    rmSync(root, { force: true, recursive: true });
    await postgres.close();
  }
}, 60_000);

test("result-graph-id prints the id the server derives from the config's key environment, never the key, and never starts the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-orch-cli-"));
  const configPath = join(root, "orchestration.json");
  const secret = randomBytes(32).toString("hex");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: {
        databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
        endpointRef: "endpoint:local-a2a",
        policy: {
          claimTimeoutMs: 60_000,
          escalationTimeoutMs: 120_000,
          maxDeliveryAttempts: 3,
          retryDelayMs: 1000,
        },
        principal: "principal:harness",
        recipient: "supervisor:harness",
        resultGraphKeyEnv: "LOOP_CLI_RESULT_GRAPH_KEY",
        routePath: "/a2a",
        sessionTtlMs: 3_600_000,
        tenant: "tenant:local",
      },
      address: "127.0.0.1:9",
      buildId: "loop-orchestration.v1",
      grants: [
        {
          from: "supervisor:source",
          operations: ["receive"],
          principal: "principal:harness",
          to: "supervisor:harness",
        },
      ],
      hostname: "127.0.0.1",
      identity: "loop-orchestration@local",
      namespace: "default",
      port: 7321,
      schema: "loop-orchestration-server.v1",
      stateDir: join(root, "state"),
      supervisors: [
        {
          manifestPath: join(root, "manifest.json"),
          principal: "principal:harness",
          supervisorId: "supervisor:harness",
          tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
        },
      ],
      taskQueue: "loop-orchestration",
    })
  );
  const runner = mock(async (_configPath: string) => undefined);
  const lines: string[] = [];
  try {
    const scope = { principal: "principal:harness", tenantId: "tenant:local" };
    const message = deriveSupervisorMessageV2WorkflowId(
      scope,
      "cli",
      "loop-orchestration"
    );
    const handled = await runOrchestrationCommand(
      ["orchestration", "result-graph-id", configPath, message],
      runner,
      {
        env: { LOOP_CLI_RESULT_GRAPH_KEY: secret },
        write: (text) => lines.push(text),
      }
    );
    expect(handled).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(lines).toEqual([
      `${deriveSupervisorMessageV2ResultGraphWorkflowId(
        SupervisorResultGraphKey.fromSecret(secret),
        scope,
        message
      )}\n`,
    ]);
    expect(lines.join("")).not.toContain(secret);
    await expect(
      runOrchestrationCommand(
        ["orchestration", "result-graph-id", configPath, message],
        runner,
        { env: {}, write: (text) => lines.push(text) }
      )
    ).rejects.toThrow(
      "missing orchestration A2A V2 result graph key environment LOOP_CLI_RESULT_GRAPH_KEY"
    );
    expect(lines).toHaveLength(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

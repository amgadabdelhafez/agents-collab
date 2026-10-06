import { expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseOrchestrationCommand,
  runOrchestrationCommand,
} from "../../src/loop/orchestration-command";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";

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

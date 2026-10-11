// fix8: `loop orchestration a2a-v2 init` with Docker and the database probe
// faked, so every branch is checked without a daemon. The Docker-backed proof
// is a2a-v2-init-docker.test.ts.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseA2AV2EnvFile } from "../../src/loop/a2a-v2-env";
import {
  type A2AV2InitDeps,
  A2AV2InitIncompleteError,
  backupStamp,
  missingA2AV2GrantPairs,
  runA2AV2Init,
} from "../../src/loop/a2a-v2-init";
import { parseLoopOrchestrationConfig } from "../../src/loop/loop-orchestration-server";
import { parseOrchestrationCommand } from "../../src/loop/orchestration-command";
import { createRunManifest, writeRunManifest } from "../../src/loop/run-state";

const NOW = new Date("2026-10-11T08:09:10.123Z");
const PASSWORD = "pw-SECRET-pw-SECRET-pw-SECRET-xx";
const KEY = "key-SECRET-key-SECRET-key-SECRET-key-SECRET";

/** The live config's shape: five mailbox-only supervisors, no a2aV2. */
const liveShapedConfig = (root: string) => ({
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  deadlines: { intervalMs: 60_000 },
  grants: [
    {
      from: "supervisor:harness",
      operations: ["receive", "cancel"],
      principal: "principal:harness",
      to: "supervisor:harvto",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@sweetmac14",
  namespace: "harness",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: join(root, "state"),
  supervisors: ["harness", "harvto", "ai-cur"].map((name) => ({
    mailbox: join(root, "mailbox", `supervisor_${name}.jsonl`),
    principal: `principal:${name}`,
    supervisorId: `supervisor:${name}`,
    tokenEnv: `LOOP_ORCH_TOKEN_${name.toUpperCase().replace("-", "_")}`,
  })),
  taskQueue: "loop-orchestration",
});

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fix8-init-")));
  const configPath = join(root, "config.json");
  const original = `${JSON.stringify(liveShapedConfig(root), null, 2)}\n`;
  writeFileSync(configPath, original, { mode: 0o600 });
  const runDir = join(root, "runs", "repo", "1");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexThreadId: "thread-1",
      cwd: root,
      mode: "paired",
      pid: process.pid,
      primaryAgent: "codex",
      repoId: "repo",
      runId: "1",
      state: "working",
      tmuxPaneLeft: "%1",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRight: "%2",
      tmuxPaneRightAgent: "codex",
    })
  );
  return {
    configPath,
    envFile: join(root, "a2a-v2.env"),
    manifestPath,
    original,
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
  };
};

interface DockerCall {
  args: string[];
  env?: Record<string, string>;
}

/** A Docker that remembers one container and volume. */
const fakeDeps = (
  state: {
    container?: { label: string; passwordInEnv?: boolean; running: boolean };
    volume?: boolean;
    probeOk?: boolean;
  } = {}
) => {
  const calls: DockerCall[] = [];
  const logs: string[] = [];
  const secrets = [PASSWORD, KEY];
  const deps: A2AV2InitDeps = {
    docker(args, env) {
      calls.push({ args: [...args], ...(env ? { env } : {}) });
      const [command] = args;
      if (command === "container") {
        // The real template prints running|label|password-in-env marks.
        return Promise.resolve(
          state.container
            ? {
                code: 0,
                stderr: "",
                stdout: `${state.container.running}|${state.container.label}|${state.container.passwordInEnv ? "password-in-env" : ""}`,
              }
            : { code: 1, stderr: "No such container", stdout: "" }
        );
      }
      if (command === "volume") {
        return Promise.resolve({
          code: state.volume ? 0 : 1,
          stderr: "",
          stdout: "",
        });
      }
      if (command === "run") {
        state.container = { label: "1", running: true };
        state.volume = true;
        return Promise.resolve({ code: 0, stderr: "", stdout: "abc123" });
      }
      if (command === "start" && state.container) {
        state.container.running = true;
        return Promise.resolve({ code: 0, stderr: "", stdout: "" });
      }
      if (command === "port") {
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout: "127.0.0.1:55432",
        });
      }
      return Promise.resolve({ code: 1, stderr: "unexpected", stdout: "" });
    },
    env: {},
    log: (line) => logs.push(line),
    now: () => NOW,
    probeDatabase: () => Promise.resolve(state.probeOk ?? true),
    secret: (bytes) => {
      const next = bytes === 24 ? secrets[0] : secrets[1];
      return next as string;
    },
    sleep: () => Promise.resolve(),
  };
  return { calls, deps, logs, state };
};

// biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
const mode = (path: string) => statSync(path).mode & 0o777;

const backups = (root: string) =>
  readdirSync(root).filter((name) => name.startsWith("config.json.bak-"));

const noSecretIn = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(KEY);
};

describe("a2a-v2 init", () => {
  test("r8 (--recipient) with no Loop binding: provisions the ledger and the 0600 env file, writes no section, and says what is missing", async () => {
    const f = fixture();
    const { calls, deps, logs } = fakeDeps();
    try {
      const failure = await runA2AV2Init(
        { configPath: f.configPath, recipient: "supervisor:harness" },
        deps
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(A2AV2InitIncompleteError);
      expect(String(failure)).toContain(
        "supervisor:harness has none; pass --manifest <supervisor-id>="
      );
      expect(String(failure)).toContain(
        "mailbox-only: supervisor:harness, supervisor:harvto, supervisor:ai-cur"
      );
      expect((failure as A2AV2InitIncompleteError).result).toMatchObject({
        configWritten: false,
        ledger: "provisioned",
      });
      // The config is untouched and nothing was backed up.
      expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
      expect(backups(f.root)).toEqual([]);
      // The ledger: named, labelled, restarting, a named volume, loopback only.
      const run = calls.find((call) => call.args[0] === "run");
      expect(run?.args).toEqual([
        "run",
        "--detach",
        "--name",
        "loop-a2a-ledger",
        "--label",
        "dev.loop.a2a-ledger=1",
        "--restart",
        "unless-stopped",
        "--volume",
        "loop-a2a-ledger-data:/var/lib/postgresql/data",
        "--mount",
        `type=bind,source=${f.root}/loop-a2a-ledger.password,target=/run/secrets/loop-a2a-ledger-password,readonly`,
        "--publish",
        "127.0.0.1:55432:5432",
        "--env",
        "POSTGRES_PASSWORD_FILE=/run/secrets/loop-a2a-ledger-password",
        "--env",
        "POSTGRES_USER=loop",
        "--env",
        "POSTGRES_DB=loop_a2a",
        expect.stringMatching(/^postgres:17-alpine@sha256:/),
      ]);
      // The password reaches the container only through the read-only
      // secret file: never argv, never an environment (Docker's or the
      // container's), so `docker inspect` cannot show it.
      for (const call of calls) {
        expect(call.env).toBeUndefined();
        noSecretIn(call.args.join(" "));
      }
      const passwordFile = join(f.root, "loop-a2a-ledger.password");
      expect(mode(passwordFile)).toBe(0o600);
      expect(readFileSync(passwordFile, "utf8")).toBe(PASSWORD);
      // The env file: 0600, both secrets, nowhere else.
      expect(mode(f.envFile)).toBe(0o600);
      const values = parseA2AV2EnvFile(readFileSync(f.envFile, "utf8"));
      expect(values.get("LOOP_A2A_V2_DATABASE_URL")).toBe(
        `postgres://loop:${PASSWORD}@127.0.0.1:55432/loop_a2a`
      );
      expect(values.get("LOOP_A2A_V2_RESULT_GRAPH_KEY")).toBe(KEY);
      noSecretIn(logs.join("\n"));
      noSecretIn(String(failure));
      expect(logs).toContain(
        "ledger created: container loop-a2a-ledger, volume loop-a2a-ledger-data, 127.0.0.1:55432"
      );
    } finally {
      f.remove();
    }
  });

  test("r9, no --manifest and no --recipient: writes a section with no recipient under the first supervisor's principal, and lists every missing grant pair without writing one", async () => {
    const f = fixture();
    const { calls, deps, logs } = fakeDeps();
    try {
      const result = await runA2AV2Init({ configPath: f.configPath }, deps);
      const backupPath = `${f.configPath}.bak-${backupStamp(NOW)}`;
      // The one grant (harness -> harvto: receive, cancel) covers receive
      // only; every other ordered pair lacks all three operations.
      const all = ["acknowledge", "claim", "receive"];
      const missingGrants = [
        { from: "harness", operations: ["acknowledge", "claim"], to: "harvto" },
        { from: "harness", operations: all, to: "ai-cur" },
        { from: "harvto", operations: all, to: "harness" },
        { from: "harvto", operations: all, to: "ai-cur" },
        { from: "ai-cur", operations: all, to: "harness" },
        { from: "ai-cur", operations: all, to: "harvto" },
      ].map((pair) => ({
        from: `supervisor:${pair.from}`,
        operations: pair.operations,
        principal: `principal:${pair.from}`,
        to: `supervisor:${pair.to}`,
      }));
      expect(result).toEqual({
        backupPath,
        configWritten: true,
        controlSupervisor: "supervisor:harness",
        envFile: f.envFile,
        ledger: "provisioned",
        missingGrants,
      });
      expect(calls.some((call) => call.args[0] === "run")).toBe(true);
      expect(readFileSync(backupPath, "utf8")).toBe(f.original);
      expect(mode(f.configPath)).toBe(0o600);
      const written = readFileSync(f.configPath, "utf8");
      noSecretIn(written);
      noSecretIn(logs.join("\n"));
      const parsed = parseLoopOrchestrationConfig(JSON.parse(written));
      expect(parsed.a2aV2).toEqual({
        databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
        endpointRef: "endpoint:loop-run",
        policy: {
          claimTimeoutMs: 300_000,
          escalationTimeoutMs: 900_000,
          maxDeliveryAttempts: 5,
          retryDelayMs: 30_000,
        },
        principal: "principal:harness",
        resultArtifacts: undefined,
        resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
        routePath: "/a2a/v2",
        sessionTtlMs: 3_600_000,
        tenant: "tenant:loop-orchestration-sweetmac14",
        workflowIdFormat: "legacy",
      });
      expect(JSON.parse(written).a2aV2).not.toHaveProperty("recipient");
      // Grants and supervisors are exactly as they were: nothing invented.
      const before = JSON.parse(f.original);
      const after = JSON.parse(written);
      expect(after.grants).toEqual(before.grants);
      expect(after.supervisors).toEqual(before.supervisors);
      expect(logs).toContain(
        `a2aV2 written to ${f.configPath}: every configured supervisor is a recipient (no r8 recipient), control principal principal:harness (supervisor:harness, the first supervisor; change with --control <supervisor-id>), workflowIdFormat legacy`
      );
      expect(logs).toContain(
        'grants: 6 of 6 sender/recipient pairs lack operations V2 needs; init never writes a grant, add each to "grants" (principal is the sender\'s):'
      );
      expect(logs).toContain(
        "missing grant: from supervisor:harness to supervisor:harvto principal principal:harness operations acknowledge, claim"
      );
      expect(
        logs.filter((line) => line.startsWith("missing grant: "))
      ).toHaveLength(6);
      // A second run is idempotent: the section is the operator's now.
      const again = await runA2AV2Init(
        { configPath: f.configPath },
        fakeDeps({ container: { label: "1", running: true }, volume: true })
          .deps
      );
      expect(again.ledger).toBe("existing-config");
      expect(readFileSync(f.configPath, "utf8")).toBe(written);
    } finally {
      f.remove();
    }
  });

  test("r9 --control names the control principal; an unknown one, or one with no principal:<name>, writes nothing; --control beside --manifest is refused", async () => {
    const chosen = fixture();
    try {
      const { deps, logs } = fakeDeps();
      const result = await runA2AV2Init(
        {
          configPath: chosen.configPath,
          controlSupervisor: "supervisor:harvto",
        },
        deps
      );
      expect(result.controlSupervisor).toBe("supervisor:harvto");
      const parsed = parseLoopOrchestrationConfig(
        JSON.parse(readFileSync(chosen.configPath, "utf8"))
      );
      expect(parsed.a2aV2?.principal).toBe("principal:harvto");
      expect(parsed.a2aV2?.recipient).toBeUndefined();
      expect(logs).toContain(
        `a2aV2 written to ${chosen.configPath}: every configured supervisor is a recipient (no r8 recipient), control principal principal:harvto (supervisor:harvto), workflowIdFormat legacy`
      );
    } finally {
      chosen.remove();
    }
    const unknown = fixture();
    try {
      const failure = await runA2AV2Init(
        {
          configPath: unknown.configPath,
          controlSupervisor: "supervisor:nobody",
        },
        fakeDeps().deps
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(A2AV2InitIncompleteError);
      expect(String(failure)).toContain(
        "--control supervisor:nobody is not a configured supervisor"
      );
      expect(readFileSync(unknown.configPath, "utf8")).toBe(unknown.original);
      expect(backups(unknown.root)).toEqual([]);
    } finally {
      unknown.remove();
    }
    const unshaped = fixture();
    try {
      const value = JSON.parse(unshaped.original);
      value.supervisors[0].principal = "harness-legacy";
      const original = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(unshaped.configPath, original, { mode: 0o600 });
      const failure = await runA2AV2Init(
        { configPath: unshaped.configPath },
        fakeDeps().deps
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(A2AV2InitIncompleteError);
      expect(String(failure)).toContain(
        "the control principal harness-legacy (supervisor:harness) is not of the form principal:<name>"
      );
      expect(readFileSync(unshaped.configPath, "utf8")).toBe(original);
    } finally {
      unshaped.remove();
    }
    const mixed = fixture();
    try {
      await expect(
        runA2AV2Init(
          {
            configPath: mixed.configPath,
            controlSupervisor: "supervisor:harvto",
            manifests: { "supervisor:harness": mixed.manifestPath },
          },
          fakeDeps().deps
        )
      ).rejects.toThrow(
        "--control applies only without --manifest and --recipient"
      );
      expect(readFileSync(mixed.configPath, "utf8")).toBe(mixed.original);
    } finally {
      mixed.remove();
    }
  });

  test("missing grant pairs count only a grant of the exact pair under the sender's principal", () => {
    const supervisors = [
      { principal: "principal:a", supervisorId: "supervisor:a" },
      { principal: "principal:b", supervisorId: "supervisor:b" },
    ];
    const full = (from: string, to: string, principal: string) => ({
      from,
      operations: ["acknowledge", "claim", "receive"],
      principal,
      to,
    });
    expect(
      missingA2AV2GrantPairs(supervisors, [
        full("supervisor:a", "supervisor:b", "principal:a"),
        full("supervisor:b", "supervisor:a", "principal:b"),
      ])
    ).toEqual([]);
    // The recipient's principal, a reversed pair, or a self-grant covers nothing.
    expect(
      missingA2AV2GrantPairs(supervisors, [
        full("supervisor:a", "supervisor:b", "principal:b"),
        full("supervisor:b", "supervisor:a", "principal:a"),
        full("supervisor:a", "supervisor:a", "principal:a"),
      ])
    ).toEqual([
      {
        from: "supervisor:a",
        operations: ["acknowledge", "claim", "receive"],
        principal: "principal:a",
        to: "supervisor:b",
      },
      {
        from: "supervisor:b",
        operations: ["acknowledge", "claim", "receive"],
        principal: "principal:b",
        to: "supervisor:a",
      },
    ]);
    // Operations are pooled across the pair's grants.
    expect(
      missingA2AV2GrantPairs(
        supervisors.slice(0, 1).concat(supervisors[1] ?? []),
        [
          {
            ...full("supervisor:a", "supervisor:b", "principal:a"),
            operations: ["receive"],
          },
          {
            ...full("supervisor:a", "supervisor:b", "principal:a"),
            operations: ["claim", "acknowledge"],
          },
        ]
      )
    ).toEqual([
      {
        from: "supervisor:b",
        operations: ["acknowledge", "claim", "receive"],
        principal: "principal:b",
        to: "supervisor:a",
      },
    ]);
  });

  test("with a Loop binding: backs up the original (0600), atomically replaces it with a validated config holding a legacy-format a2aV2 section, and never writes a secret into it", async () => {
    const f = fixture();
    const { deps, logs } = fakeDeps();
    try {
      const result = await runA2AV2Init(
        {
          configPath: f.configPath,
          manifests: { "supervisor:harness": f.manifestPath },
        },
        deps
      );
      const backupPath = `${f.configPath}.bak-${backupStamp(NOW)}`;
      expect(result).toEqual({
        backupPath,
        configWritten: true,
        envFile: f.envFile,
        ledger: "provisioned",
        recipient: "supervisor:harness",
      });
      expect(backupStamp(NOW)).toBe("20261011T080910Z");
      expect(readFileSync(backupPath, "utf8")).toBe(f.original);
      expect(mode(backupPath)).toBe(0o600);
      expect(mode(f.configPath)).toBe(0o600);
      const written = readFileSync(f.configPath, "utf8");
      noSecretIn(written);
      noSecretIn(logs.join("\n"));
      const parsed = parseLoopOrchestrationConfig(JSON.parse(written));
      expect(parsed.a2aV2).toEqual({
        databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
        endpointRef: "endpoint:codex-app-server",
        policy: {
          claimTimeoutMs: 300_000,
          escalationTimeoutMs: 900_000,
          maxDeliveryAttempts: 5,
          retryDelayMs: 30_000,
        },
        principal: "principal:harness",
        recipient: "supervisor:harness",
        resultArtifacts: undefined,
        resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
        routePath: "/a2a/v2",
        sessionTtlMs: 3_600_000,
        tenant: "tenant:loop-orchestration-sweetmac14",
        workflowIdFormat: "legacy",
      });
      expect(
        parsed.supervisors.find(
          (entry) => entry.supervisorId === "supervisor:harness"
        )
      ).toMatchObject({ manifestPath: f.manifestPath });
      // Everything else is preserved.
      const before = JSON.parse(f.original);
      const after = JSON.parse(written);
      expect(after.grants).toEqual(before.grants);
      expect(after.deadlines).toEqual(before.deadlines);
      expect(after.supervisors[1]).toEqual(before.supervisors[1]);
      // No temporary file is left behind.
      expect(
        readdirSync(f.root).filter((name) => name.endsWith(".tmp"))
      ).toEqual([]);
    } finally {
      f.remove();
    }
  });

  test("idempotent: a second run changes nothing, provisions nothing and backs up nothing", async () => {
    const f = fixture();
    const first = fakeDeps();
    try {
      await runA2AV2Init(
        {
          configPath: f.configPath,
          manifests: { "supervisor:harness": f.manifestPath },
        },
        first.deps
      );
      const config = readFileSync(f.configPath, "utf8");
      const env = readFileSync(f.envFile, "utf8");
      const second = fakeDeps(first.state);
      const result = await runA2AV2Init(
        {
          configPath: f.configPath,
          manifests: { "supervisor:harness": f.manifestPath },
        },
        second.deps
      );
      expect(result).toEqual({
        configWritten: false,
        envFile: f.envFile,
        ledger: "existing-config",
      });
      expect(readFileSync(f.configPath, "utf8")).toBe(config);
      expect(readFileSync(f.envFile, "utf8")).toBe(env);
      expect(backups(f.root)).toHaveLength(1);
      expect(second.calls.some((call) => call.args[0] === "run")).toBe(false);
    } finally {
      f.remove();
    }
  });

  test("a rerun after an incomplete init reuses the container and the password in the env file", async () => {
    const f = fixture();
    const first = fakeDeps();
    try {
      await runA2AV2Init(
        { configPath: f.configPath, recipient: "supervisor:harness" },
        first.deps
      ).catch(() => undefined);
      const env = parseA2AV2EnvFile(readFileSync(f.envFile, "utf8"));
      first.state.container = { label: "1", running: false };
      // The stopped container's bind mount needs its secret file back.
      rmSync(join(f.root, "loop-a2a-ledger.password"));
      const second = fakeDeps(first.state);
      // A fresh secret would differ; the stored one must be reused.
      second.deps.secret = () => "a-different-secret-that-must-not-be-used";
      const result = await runA2AV2Init(
        {
          configPath: f.configPath,
          manifests: { "supervisor:harness": f.manifestPath },
        },
        second.deps
      );
      expect(result.ledger).toBe("reused");
      expect(second.calls.map((call) => call.args[0])).toEqual([
        "container",
        "start",
        "port",
      ]);
      expect(parseA2AV2EnvFile(readFileSync(f.envFile, "utf8"))).toEqual(env);
      expect(mode(f.envFile)).toBe(0o600);
      const passwordFile = join(f.root, "loop-a2a-ledger.password");
      expect(readFileSync(passwordFile, "utf8")).toBe(PASSWORD);
      expect(mode(passwordFile)).toBe(0o600);
    } finally {
      f.remove();
    }
  });

  /** An env file as init writes it, for a ledger on `port`. */
  const writeEnvFile = (f: ReturnType<typeof fixture>, port = 55_432) =>
    writeFileSync(
      f.envFile,
      `LOOP_A2A_V2_DATABASE_URL=postgres://loop:${PASSWORD}@127.0.0.1:${port}/loop_a2a\nLOOP_A2A_V2_RESULT_GRAPH_KEY=${KEY}\n`,
      { mode: 0o600 }
    );

  test("a ledger created before the secret file (password in its container environment) is reused as it is, with one line naming the recreate command", async () => {
    const f = fixture();
    writeEnvFile(f);
    const { calls, deps, logs } = fakeDeps({
      container: { label: "1", passwordInEnv: true, running: false },
      volume: true,
    });
    try {
      const failure = await runA2AV2Init(
        { configPath: f.configPath, recipient: "supervisor:harness" },
        deps
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect((failure as A2AV2InitIncompleteError).result.ledger).toBe(
        "reused"
      );
      expect(calls.map((call) => call.args[0])).toEqual([
        "container",
        "start",
        "port",
      ]);
      expect(logs).toContain(
        `ledger loop-a2a-ledger was created with POSTGRES_PASSWORD in its container environment (fix8 before the secret file): \`docker inspect loop-a2a-ledger\` shows the password to anyone who can reach the Docker daemon. Reused as it is. To recreate it with the 0600 secret file (the volume loop-a2a-ledger-data, its data and the password are kept): docker rm -f loop-a2a-ledger && loop orchestration a2a-v2 init ${f.configPath}`
      );
      // Its own environment holds the password; no second copy is written.
      expect(existsSync(join(f.root, "loop-a2a-ledger.password"))).toBe(false);
      noSecretIn(logs.join("\n"));
    } finally {
      f.remove();
    }
  });

  test("with a section written, init recreates a removed ledger from its kept volume with the secret file, on the env file's port; a present one is only kept running", async () => {
    const f = fixture();
    try {
      await runA2AV2Init(
        {
          configPath: f.configPath,
          manifests: { "supervisor:harness": f.manifestPath },
        },
        fakeDeps().deps
      );
      // The ledger was provisioned on another port; the operator removed the
      // container (the documented recreate command), the volume stays.
      writeEnvFile(f, 55_499);
      rmSync(join(f.root, "loop-a2a-ledger.password"));
      const removed = fakeDeps({ volume: true });
      const result = await runA2AV2Init(
        { configPath: f.configPath },
        removed.deps
      );
      expect(result.ledger).toBe("existing-config");
      const run = removed.calls.find((call) => call.args[0] === "run");
      expect(run?.args).toContain("127.0.0.1:55499:5432");
      expect(run?.args).toContain(
        "POSTGRES_PASSWORD_FILE=/run/secrets/loop-a2a-ledger-password"
      );
      expect(run?.env).toBeUndefined();
      expect(
        readFileSync(join(f.root, "loop-a2a-ledger.password"), "utf8")
      ).toBe(PASSWORD);
      expect(removed.logs[0]).toStartWith(
        "ledger recreated with its secret file: container loop-a2a-ledger"
      );
      // Present and running: nothing but the inspect.
      const present = fakeDeps({
        container: { label: "1", running: true },
        volume: true,
      });
      await runA2AV2Init({ configPath: f.configPath }, present.deps);
      expect(present.calls.map((call) => call.args[0])).toEqual([
        "container",
        "port",
      ]);
      // No volume left: nothing is recreated (that would be a new, empty
      // ledger the operator did not ask for).
      const gone = fakeDeps();
      await runA2AV2Init({ configPath: f.configPath }, gone.deps);
      expect(gone.calls.map((call) => call.args[0])).toEqual([
        "container",
        "volume",
      ]);
    } finally {
      f.remove();
    }
  });

  test("a config directory docker --mount cannot carry is refused before any container is created", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "fix8-init-")));
    const odd = join(base, "with,comma");
    mkdirSync(odd);
    const configPath = join(odd, "config.json");
    writeFileSync(configPath, JSON.stringify(liveShapedConfig(odd)), {
      mode: 0o600,
    });
    const { calls, deps } = fakeDeps();
    try {
      await expect(runA2AV2Init({ configPath }, deps)).rejects.toThrow(
        "which docker --mount cannot carry"
      );
      expect(calls.some((call) => call.args[0] === "run")).toBe(false);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  test("refuses a group- or world-readable env file, a foreign container, and an orphaned volume", async () => {
    const f = fixture();
    try {
      writeFileSync(f.envFile, "LOOP_A2A_V2_RESULT_GRAPH_KEY=x\n", {
        mode: 0o600,
      });
      chmodSync(f.envFile, 0o644);
      await expect(
        runA2AV2Init({ configPath: f.configPath }, fakeDeps().deps)
      ).rejects.toThrow("readable by group or others");
      rmSync(f.envFile);
      await expect(
        runA2AV2Init(
          { configPath: f.configPath },
          fakeDeps({ container: { label: "", running: true } }).deps
        )
      ).rejects.toThrow("was not created by a2a-v2 init");
      await expect(
        runA2AV2Init(
          { configPath: f.configPath },
          fakeDeps({ volume: true }).deps
        )
      ).rejects.toThrow("exists but its password is not in the env file");
      expect(existsSync(f.envFile)).toBe(false);
      expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
    } finally {
      f.remove();
    }
  });

  test("a config changed while init ran is not replaced and not backed up", async () => {
    const f = fixture();
    const { deps } = fakeDeps();
    const edited = `${f.original.trimEnd()}\n\n`;
    deps.now = () => {
      // The operator edits the config between init's read and its replace.
      writeFileSync(f.configPath, edited);
      return NOW;
    };
    try {
      await expect(
        runA2AV2Init(
          {
            configPath: f.configPath,
            manifests: { "supervisor:harness": f.manifestPath },
          },
          deps
        )
      ).rejects.toThrow("changed while init ran; nothing was replaced");
      expect(readFileSync(f.configPath, "utf8")).toBe(edited);
      expect(backups(f.root)).toEqual([]);
      expect(
        readdirSync(f.root).filter((name) => name.endsWith(".tmp"))
      ).toEqual([]);
    } finally {
      f.remove();
    }
  });

  test("an unreachable ledger fails the init without writing the config", async () => {
    const f = fixture();
    try {
      await expect(
        runA2AV2Init(
          {
            configPath: f.configPath,
            manifests: { "supervisor:harness": f.manifestPath },
          },
          fakeDeps({ probeOk: false }).deps
        )
      ).rejects.toThrow("did not accept queries");
      expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
      expect(backups(f.root)).toEqual([]);
    } finally {
      f.remove();
    }
  });

  test("the CLI parses init and its flags, and refuses malformed ones", () => {
    expect(
      parseOrchestrationCommand(
        [
          "orchestration",
          "a2a-v2",
          "init",
          "config.json",
          "--manifest",
          "supervisor:a=/runs/1/manifest.json",
          "--manifest",
          "supervisor:b=/runs/2/manifest.json",
          "--recipient",
          "supervisor:a",
          "--control",
          "supervisor:b",
          "--ledger-name",
          "ledger-x",
          "--ledger-port",
          "55433",
        ],
        "/cwd"
      )
    ).toEqual({
      command: "a2a-v2-init",
      configPath: "/cwd/config.json",
      containerName: "ledger-x",
      controlSupervisor: "supervisor:b",
      ledgerPort: 55_433,
      manifests: {
        "supervisor:a": "/runs/1/manifest.json",
        "supervisor:b": "/runs/2/manifest.json",
      },
      recipient: "supervisor:a",
    });
    for (const argv of [
      ["orchestration", "a2a-v2", "init"],
      ["orchestration", "a2a-v2", "setup", "c.json"],
      ["orchestration", "a2a-v2", "init", "c.json", "--recipient"],
      ["orchestration", "a2a-v2", "init", "c.json", "--control"],
      [
        "orchestration",
        "a2a-v2",
        "init",
        "c.json",
        "--control",
        "a",
        "--control",
        "b",
      ],
      ["orchestration", "a2a-v2", "init", "c.json", "--bogus", "x"],
      ["orchestration", "a2a-v2", "init", "c.json", "--manifest", "noequals"],
      [
        "orchestration",
        "a2a-v2",
        "init",
        "c.json",
        "--recipient",
        "a",
        "--recipient",
        "b",
      ],
    ]) {
      expect(() => parseOrchestrationCommand(argv, "/cwd")).toThrow(
        "loop orchestration a2a-v2 init"
      );
    }
  });
});

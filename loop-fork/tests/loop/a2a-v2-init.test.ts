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
    container?: { label: string; running: boolean };
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
        return Promise.resolve(
          state.container
            ? {
                code: 0,
                stderr: "",
                stdout: `${state.container.running} ${state.container.label}`,
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
  test("live-shaped config with no Loop binding: provisions the ledger and the 0600 env file, writes no section, and says what is missing", async () => {
    const f = fixture();
    const { calls, deps, logs } = fakeDeps();
    try {
      const failure = await runA2AV2Init(
        { configPath: f.configPath },
        deps
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(A2AV2InitIncompleteError);
      expect(String(failure)).toContain(
        "no configured supervisor has one; pass --manifest <supervisor-id>="
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
        "--publish",
        "127.0.0.1:55432:5432",
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        "POSTGRES_USER=loop",
        "--env",
        "POSTGRES_DB=loop_a2a",
        expect.stringMatching(/^postgres:17-alpine@sha256:/),
      ]);
      // The password reaches Docker only through the child environment.
      expect(run?.env).toEqual({ POSTGRES_PASSWORD: PASSWORD });
      for (const call of calls) {
        noSecretIn(call.args.join(" "));
      }
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
      await runA2AV2Init({ configPath: f.configPath }, first.deps).catch(
        () => undefined
      );
      const env = parseA2AV2EnvFile(readFileSync(f.envFile, "utf8"));
      first.state.container = { label: "1", running: false };
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
    } finally {
      f.remove();
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

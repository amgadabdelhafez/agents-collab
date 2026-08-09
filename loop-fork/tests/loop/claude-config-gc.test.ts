import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gcStaleClaudeBridgeRegistrations,
  resolveClaudeRegistryPath,
} from "../../src/loop/claude-config-gc";
import { type TmuxSkipRecord, targetArgv } from "../../src/loop/tmux-socket";

const makeRoot = (): string =>
  mkdtempSync(join(tmpdir(), "loop-claude-config-gc-"));

const writeManifest = (
  runDir: string,
  manifest: Record<string, unknown>
): void => {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8"
  );
};

const bridgeConfig = (runDir: string, command = process.execPath) => ({
  args: ["src/cli.ts", "__bridge-mcp", runDir, "claude"],
  command,
  type: "stdio",
});

test("Claude registry path honors the isolated automation config directory", () => {
  expect(
    resolveClaudeRegistryPath(
      { CLAUDE_CONFIG_DIR: "/private/tmp/isolated-claude" },
      "/Users/example"
    )
  ).toBe("/private/tmp/isolated-claude/.claude.json");
  expect(resolveClaudeRegistryPath({}, "/Users/example")).toBe(
    "/Users/example/.claude.json"
  );
});

test("startup GC removes only dead loop-owned bridge registrations", () => {
  const root = makeRoot();
  const projectPath = join(root, "project");
  const liveRun = join(root, "runs", "live");
  const terminalRun = join(root, "runs", "terminal");
  const deadRun = join(root, "runs", "dead");
  const missingRun = join(root, "runs", "missing");
  mkdirSync(projectPath, { recursive: true });
  writeManifest(liveRun, { pid: 111, state: "working", status: "running" });
  writeManifest(terminalRun, {
    pid: 222,
    state: "completed",
    status: "done",
  });
  writeManifest(deadRun, {
    pid: 333,
    runId: "dead",
    state: "working",
    status: "running",
    tmuxSession: "dead-loop",
    tmuxSocket: "/tmp/loop-dead.sock",
  });
  const registryPath = join(root, ".claude.json");
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      projects: {
        [projectPath]: {
          mcpServers: {
            "foreign-server": { command: "/usr/bin/true", args: [] },
            "loop-bridge-malformed": null,
            "loop-bridge-live": bridgeConfig(liveRun),
            "loop-bridge-terminal": bridgeConfig(terminalRun),
            "loop-bridge-dead": bridgeConfig(deadRun),
            "loop-bridge-missing": bridgeConfig(missingRun),
          },
        },
      },
    })}\n`,
    "utf8"
  );
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const tmuxCalls: string[][] = [];
  const lines: string[] = [];
  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: (path) => path !== missingRun,
      pidAlive: (pid) => pid === 111,
      runCommand: (args, cwd) => {
        calls.push({ args, cwd });
        return { exitCode: 0 };
      },
      tmuxLiveness: (target) => {
        tmuxCalls.push(targetArgv(target, "has-session"));
        return "dead";
      },
    },
    log: (line) => lines.push(line),
    registryPath,
  });

  expect(result).toEqual({ failed: 0, kept: 1, removed: 3, scanned: 4 });
  expect(calls.map((call) => call.args.at(-1))).toEqual([
    "loop-bridge-terminal",
    "loop-bridge-dead",
    "loop-bridge-missing",
  ]);
  expect(calls.every((call) => call.cwd === projectPath)).toBe(true);
  expect(tmuxCalls).toEqual([
    ["tmux", "-S", "/tmp/loop-dead.sock", "has-session", "-t", "dead-loop"],
  ]);
  expect(lines).toHaveLength(3);
  rmSync(root, { force: true, recursive: true });
});

test("startup GC preserves registrations it cannot remove safely", () => {
  const root = makeRoot();
  const missingProject = join(root, "missing-project");
  const missingRun = join(root, "missing-run");
  const registryPath = join(root, ".claude.json");
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      projects: {
        [missingProject]: {
          mcpServers: {
            "loop-bridge-orphan": bridgeConfig(missingRun),
          },
        },
      },
    })}\n`,
    "utf8"
  );
  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: () => false,
      runCommand: () => {
        throw new Error("must not run");
      },
    },
    registryPath,
  });
  expect(result).toEqual({ failed: 0, kept: 1, removed: 0, scanned: 1 });
  rmSync(root, { force: true, recursive: true });
});

test("startup GC preserves a registration when tmux liveness is unknown", () => {
  const root = makeRoot();
  const projectPath = join(root, "project");
  const runDir = join(root, "run");
  const registryPath = join(root, ".claude.json");
  const skips: TmuxSkipRecord[] = [];
  mkdirSync(projectPath, { recursive: true });
  writeManifest(runDir, {
    pid: 999,
    runId: "unknown",
    state: "working",
    status: "running",
    tmuxSession: "possibly-live-loop",
    tmuxSocket: "/tmp/possibly-live.sock",
  });
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      projects: {
        [projectPath]: {
          mcpServers: {
            "loop-bridge-unknown": bridgeConfig(runDir),
          },
        },
      },
    })}\n`,
    "utf8"
  );
  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: () => true,
      pidAlive: () => false,
      runCommand: () => {
        throw new Error("unknown liveness must not remove the registration");
      },
      skipSink: { record: (record) => skips.push(record) },
      tmuxLiveness: () => "unknown",
    },
    registryPath,
  });
  expect(result).toEqual({ failed: 0, kept: 1, removed: 0, scanned: 1 });
  expect(skips).toEqual([
    {
      consumer: "claude-config-gc.staleReason",
      effectSkipped: "remove-claude-bridge-registration",
      pane: null,
      reason:
        "exact manifest target liveness is indeterminate; preserving registration",
      runId: "unknown",
      session: "possibly-live-loop",
      socketState: "unknown",
    },
  ]);
  rmSync(root, { force: true, recursive: true });
});

test.each([
  ["missing", {}, "missing"],
  ["invalid", { tmuxSocket: "relative.sock" }, "invalid"],
  [
    "conflicting",
    { tmux_socket: "/tmp/server-b.sock", tmuxSocket: "/tmp/server-a.sock" },
    "conflicting",
  ],
] as const)("startup GC records a %s manifest target and removes nothing", (label, socketFields, socketState) => {
  const root = makeRoot();
  const projectPath = join(root, "project");
  const runDir = join(root, "run");
  const registryPath = join(root, ".claude.json");
  const skips: TmuxSkipRecord[] = [];
  mkdirSync(projectPath, { recursive: true });
  writeManifest(runDir, {
    pid: 999,
    runId: label,
    state: "working",
    status: "running",
    tmuxSession: "possibly-live-loop",
    ...socketFields,
  });
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      projects: {
        [projectPath]: {
          mcpServers: {
            "loop-bridge-invalid": bridgeConfig(runDir),
          },
        },
      },
    })}\n`,
    "utf8"
  );

  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: () => true,
      pidAlive: () => false,
      runCommand: () => {
        throw new Error("invalid target must not remove the registration");
      },
      skipSink: { record: (record) => skips.push(record) },
      tmuxLiveness: () => {
        throw new Error("invalid target must not be probed");
      },
    },
    registryPath,
  });

  expect(result).toEqual({ failed: 0, kept: 1, removed: 0, scanned: 1 });
  expect(skips).toEqual([
    {
      consumer: "claude-config-gc.staleReason",
      effectSkipped: "remove-claude-bridge-registration",
      pane: null,
      reason: "manifest target is unavailable; preserving registration",
      runId: label,
      session: "possibly-live-loop",
      socketState,
    },
  ]);
  rmSync(root, { force: true, recursive: true });
});

test("startup GC preserves an active detached run with missing tmux ownership", () => {
  const root = makeRoot();
  const projectPath = join(root, "project");
  const runDir = join(root, "run");
  const registryPath = join(root, ".claude.json");
  mkdirSync(projectPath, { recursive: true });
  writeManifest(runDir, {
    pid: 4405,
    runId: "101",
    state: "working",
    status: "running",
    tmuxPaneLeft: "%0",
    tmuxPaneRight: "%1",
  });
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      projects: {
        [projectPath]: {
          mcpServers: {
            "loop-bridge-harvto-101": bridgeConfig(runDir),
          },
        },
      },
    })}\n`,
    "utf8"
  );

  const skips: TmuxSkipRecord[] = [];
  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: () => true,
      pidAlive: () => false,
      runCommand: () => {
        throw new Error("missing topology must not remove an active bridge");
      },
      skipSink: { record: (record) => skips.push(record) },
      tmuxLiveness: () => {
        throw new Error("there is no target to probe");
      },
    },
    registryPath,
  });

  expect(result).toEqual({ failed: 0, kept: 1, removed: 0, scanned: 1 });
  expect(skips).toEqual([
    {
      consumer: "claude-config-gc.staleReason",
      effectSkipped: "remove-claude-bridge-registration",
      pane: null,
      reason:
        "active run has no manifest-backed tmux target; preserving registration",
      runId: "101",
      session: null,
      socketState: "unknown",
    },
  ]);
  rmSync(root, { force: true, recursive: true });
});

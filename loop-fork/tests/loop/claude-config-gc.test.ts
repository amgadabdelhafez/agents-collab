import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gcStaleClaudeBridgeRegistrations,
  resolveClaudeRegistryPath,
} from "../../src/loop/claude-config-gc";

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
    state: "working",
    status: "running",
    tmuxSession: "dead-loop",
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
  const lines: string[] = [];
  const result = gcStaleClaudeBridgeRegistrations({
    deps: {
      pathExists: (path) => path !== missingRun,
      pidAlive: (pid) => pid === 111,
      runCommand: (args, cwd) => {
        calls.push({ args, cwd });
        return { exitCode: 0 };
      },
      tmuxSessionAlive: () => false,
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

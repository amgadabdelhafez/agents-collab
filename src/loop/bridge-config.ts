import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_SERVER, BRIDGE_SUBCOMMAND } from "./bridge-constants";
import { sanitizeBase } from "./git";
import { buildLaunchArgv } from "./launch";
import type { Agent } from "./types";

const CODEX_AUTO_APPROVED_BRIDGE_TOOLS = [
  "send_message",
  "bridge_status",
  "receive_messages",
] as const;
const CODEX_BRIDGE_APPROVAL_MODE = "approve";
const REPO_ID_HASH_SUFFIX_RE = /-[0-9a-f]{12}$/;

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const stringifyToml = (value: string): string => JSON.stringify(value);

interface BridgeServerConfig {
  args: string[];
  command: string;
  type: "stdio";
}

const buildBridgeServerConfig = (
  runDir: string,
  source: Agent,
  launchArgv: string[]
): BridgeServerConfig => {
  const [command, ...baseArgs] = launchArgv;
  return {
    args: [...baseArgs, BRIDGE_SUBCOMMAND, runDir, source],
    command,
    type: "stdio",
  };
};

const buildBridgeFileConfig = (
  serverName: string,
  config: BridgeServerConfig
): { mcpServers: Record<string, BridgeServerConfig> } => ({
  mcpServers: {
    [serverName]: config,
  },
});

export const legacyClaudeChannelServerName = (runId: string): string =>
  `${BRIDGE_SERVER}-${sanitizeBase(runId)}`;

const readableRepoSegment = (repoId?: string): string | undefined => {
  const value = repoId?.trim();
  if (!value) {
    return undefined;
  }
  return sanitizeBase(value.replace(REPO_ID_HASH_SUFFIX_RE, ""));
};

export const legacyRepoScopedClaudeChannelServerName = (
  runId: string,
  repoId: string
): string => `${BRIDGE_SERVER}-${sanitizeBase(repoId)}-${sanitizeBase(runId)}`;

export const claudeChannelServerName = (
  runId: string,
  repoId?: string
): string => {
  const repoSegment = readableRepoSegment(repoId);
  return repoSegment
    ? `${BRIDGE_SERVER}-${repoSegment}-${sanitizeBase(runId)}`
    : legacyClaudeChannelServerName(runId);
};

export const generatedClaudeChannelServerNames = (
  runId: string,
  repoId?: string
): string[] => {
  const names = [legacyClaudeChannelServerName(runId)];
  if (!repoId?.trim()) {
    return names;
  }
  return Array.from(
    new Set([
      claudeChannelServerName(runId, repoId),
      legacyRepoScopedClaudeChannelServerName(runId, repoId),
      ...names,
    ])
  );
};

export const resolveClaudeChannelServerName = (
  runId: string,
  repoId: string | undefined,
  storedName?: string
): string => {
  const nextServer = claudeChannelServerName(runId, repoId);
  if (!storedName?.trim()) {
    return nextServer;
  }
  return generatedClaudeChannelServerNames(runId, repoId).includes(storedName)
    ? nextServer
    : storedName;
};

export const buildClaudeChannelServerConfig = (
  launchArgv: string[],
  runDir: string
): string =>
  JSON.stringify(buildBridgeServerConfig(runDir, "claude", launchArgv));

export const buildCodexBridgeConfigArgs = (
  runDir: string,
  source: Agent
): string[] => {
  const config = buildBridgeServerConfig(runDir, source, buildLaunchArgv());
  const approvalArgs = CODEX_AUTO_APPROVED_BRIDGE_TOOLS.flatMap((tool) => [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.tools.${tool}.approval_mode=${stringifyToml(
      CODEX_BRIDGE_APPROVAL_MODE
    )}`,
  ]);
  return [
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.command=${stringifyToml(config.command)}`,
    "-c",
    `mcp_servers.${BRIDGE_SERVER}.args=${JSON.stringify(config.args)}`,
    ...approvalArgs,
  ];
};

export const ensureClaudeBridgeConfig = (
  runDir: string,
  source: Agent,
  serverName = BRIDGE_SERVER
): string => {
  return ensureAgentBridgeConfig(runDir, source, serverName);
};

export const ensureAgentBridgeConfig = (
  runDir: string,
  source: Agent,
  serverName = BRIDGE_SERVER
): string => {
  const path = join(runDir, `${source}-mcp.json`);
  ensureParentDir(path);
  writeFileSync(
    path,
    `${JSON.stringify(
      buildBridgeFileConfig(
        serverName,
        buildBridgeServerConfig(runDir, source, buildLaunchArgv())
      ),
      null,
      2
    )}\n`,
    "utf8"
  );
  return path;
};

/**
 * Write bridge MCP config into the project directory for agents that
 * load MCP from project config rather than --mcp-config CLI flag.
 * - Cursor: .cursor/mcp.json
 * - Gemini: .gemini/settings.json
 */
export const injectProjectBridgeConfig = (
  cwd: string,
  runDir: string,
  source: Agent,
  serverName = BRIDGE_SERVER
): void => {
  const config = buildBridgeServerConfig(runDir, source, buildLaunchArgv());

  const readExistingConfig = (path: string): Record<string, unknown> => {
    try {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read ${path}: ${String(err)}`);
      }
      return {};
    }
  };

  const mergeAndWrite = (configPath: string): void => {
    const existing = readExistingConfig(configPath);
    const merged = {
      ...existing,
      mcpServers: {
        ...((existing.mcpServers as Record<string, unknown>) ?? {}),
        [serverName]: config,
      },
    };
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  };

  if (source === "cursor") {
    const cursorDir = join(cwd, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    mergeAndWrite(join(cursorDir, "mcp.json"));
  }

  if (source === "gemini") {
    const geminiDir = join(cwd, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    mergeAndWrite(join(geminiDir, "settings.json"));
  }

  if (source === "copilot") {
    const copilotDir = join(cwd, ".github", "copilot");
    mkdirSync(copilotDir, { recursive: true });
    mergeAndWrite(join(copilotDir, "mcp.json"));
  }
};

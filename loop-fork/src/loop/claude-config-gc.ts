import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "bun";

const LOOP_BRIDGE_PREFIX = "loop-bridge-";
const BRIDGE_SUBCOMMAND = "__bridge-mcp";
const ACTIVE_STATES = new Set([
  "submitted",
  "working",
  "reviewing",
  "input-required",
]);
const TERMINAL_STATES = new Set(["completed", "done", "failed", "stopped"]);

interface CommandResult {
  exitCode?: number | null;
  stderr?: string | Uint8Array;
}

interface LoopBridgeRegistration {
  command: string;
  projectPath: string;
  runDir: string;
  serverName: string;
}

interface GcDependencies {
  pathExists: (path: string) => boolean;
  pidAlive: (pid: number) => boolean;
  runCommand: (
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ) => CommandResult;
  tmuxSessionAlive: (session: string) => boolean | undefined;
}

export interface ClaudeBridgeGcResult {
  failed: number;
  kept: number;
  removed: number;
  scanned: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stderrText = (value: CommandResult["stderr"]): string => {
  if (!value) {
    return "";
  }
  return typeof value === "string"
    ? value.trim()
    : new TextDecoder().decode(value).trim();
};

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const TMUX_LIVENESS_TIMEOUT_MS = 750;
const CLAUDE_MCP_REMOVE_TIMEOUT_MS = 1500;

const defaultTmuxSessionAlive = (session: string): boolean | undefined => {
  try {
    const result = spawnSync(["tmux", "has-session", "-t", session], {
      killSignal: "SIGKILL",
      stderr: "ignore",
      stdout: "ignore",
      timeout: TMUX_LIVENESS_TIMEOUT_MS,
    });
    if (result.signalCode) {
      return undefined;
    }
    return result.exitCode === 0;
  } catch {
    return undefined;
  }
};

const defaultRunCommand = (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): CommandResult =>
  spawnSync(args, {
    cwd,
    env,
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "ignore",
    timeout: CLAUDE_MCP_REMOVE_TIMEOUT_MS,
  });

const defaultDependencies: GcDependencies = {
  pathExists: existsSync,
  pidAlive: defaultPidAlive,
  runCommand: defaultRunCommand,
  tmuxSessionAlive: defaultTmuxSessionAlive,
};

export const resolveClaudeRegistryPath = (
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): string => {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || userHome, ".claude.json");
};

const parseLoopBridgeRegistration = (
  projectPath: string,
  serverName: string,
  configValue: unknown
): LoopBridgeRegistration | undefined => {
  if (!serverName.startsWith(LOOP_BRIDGE_PREFIX)) {
    return undefined;
  }
  const config = asRecord(configValue);
  if (!config) {
    return undefined;
  }
  if (typeof config.command !== "string" || !Array.isArray(config.args)) {
    return undefined;
  }
  const args = config.args.filter(
    (value): value is string => typeof value === "string"
  );
  const subcommandIndex = args.indexOf(BRIDGE_SUBCOMMAND);
  const runDir = args[subcommandIndex + 1];
  if (subcommandIndex < 0 || !runDir || !isAbsolute(runDir)) {
    return undefined;
  }
  return {
    command: config.command,
    projectPath,
    runDir,
    serverName,
  };
};

const readRegistry = (path: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

const readManifest = (runDir: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(
      JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))
    );
  } catch {
    return undefined;
  }
};

const stringField = (
  record: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const positiveIntegerField = (
  record: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
};

const firstTerminalState = (
  manifest: Record<string, unknown>
): string | undefined =>
  [stringField(manifest, "state"), stringField(manifest, "status")].find(
    (value) => value && TERMINAL_STATES.has(value)
  );

const declaresActiveRun = (manifest: Record<string, unknown>): boolean =>
  [stringField(manifest, "state"), stringField(manifest, "status")].some(
    (value) => value && (ACTIVE_STATES.has(value) || value === "running")
  );

const staleReason = (
  registration: LoopBridgeRegistration,
  deps: GcDependencies
): string | undefined => {
  if (
    isAbsolute(registration.command) &&
    !deps.pathExists(registration.command)
  ) {
    return "command missing";
  }
  if (!deps.pathExists(registration.runDir)) {
    return "run directory missing";
  }
  const manifest = readManifest(registration.runDir);
  if (!manifest) {
    return "run manifest missing";
  }
  const terminalState = firstTerminalState(manifest);
  if (terminalState) {
    return `run is ${terminalState}`;
  }
  const tmuxSession = stringField(manifest, "tmuxSession");
  if (tmuxSession) {
    const alive = deps.tmuxSessionAlive(tmuxSession);
    // A timed-out or failed liveness probe is unknown, not proof of death.
    // Preserve the registration rather than disrupting a possibly live loop.
    if (alive !== false) {
      return undefined;
    }
  }
  const pid = positiveIntegerField(manifest, "pid");
  if (pid && deps.pidAlive(pid)) {
    return undefined;
  }
  if (declaresActiveRun(manifest) && (tmuxSession || pid)) {
    return "run liveness is gone";
  }
  return undefined;
};

export const gcStaleClaudeBridgeRegistrations = (
  options: {
    deps?: Partial<GcDependencies>;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    registryPath?: string;
  } = {}
): ClaudeBridgeGcResult => {
  const env = options.env ?? process.env;
  const log = options.log ?? console.error;
  const deps = { ...defaultDependencies, ...options.deps };
  const registryPath = options.registryPath ?? resolveClaudeRegistryPath(env);
  const registry = readRegistry(registryPath);
  const result: ClaudeBridgeGcResult = {
    failed: 0,
    kept: 0,
    removed: 0,
    scanned: 0,
  };
  const projects = asRecord(registry?.projects);
  for (const [projectPath, projectValue] of Object.entries(projects ?? {})) {
    const project = asRecord(projectValue);
    const servers = asRecord(project?.mcpServers);
    for (const [serverName, config] of Object.entries(servers ?? {})) {
      const registration = parseLoopBridgeRegistration(
        projectPath,
        serverName,
        config
      );
      if (!registration) {
        continue;
      }
      result.scanned += 1;
      const reason = staleReason(registration, deps);
      if (!(reason && deps.pathExists(projectPath))) {
        result.kept += 1;
        continue;
      }
      const removal = deps.runCommand(
        [
          "claude",
          "mcp",
          "remove",
          "--scope",
          "local",
          registration.serverName,
        ],
        projectPath,
        env
      );
      if (removal.exitCode === 0) {
        result.removed += 1;
        log(
          `[loop] removed stale Claude bridge "${registration.serverName}" (${reason})`
        );
        continue;
      }
      result.failed += 1;
      log(
        `[loop] failed to remove stale Claude bridge "${registration.serverName}": ${stderrText(removal.stderr) || `exit code ${removal.exitCode ?? "unknown"}`}`
      );
    }
  }
  return result;
};

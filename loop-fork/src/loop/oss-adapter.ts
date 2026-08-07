import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_SERVER, BRIDGE_SUBCOMMAND } from "./bridge-constants";
import { buildLaunchArgv } from "./launch";

// Provider-neutral OpenCode-backed seat.
//
// Isolation contract, measured against opencode 1.4.3:
//   OPENCODE_CONFIG=<file> does NOT isolate — the user's global config and any
//   project config still merge in. OPENCODE_CONFIG_DIR=<run-scoped dir> does
//   drop the user's global config, and a same-named entry in the run-scoped
//   config wins over a project-level opencode.json. A repository-level
//   opencode.json in the working tree can still contribute entries; that is
//   project configuration, not unrelated user configuration.
export const OSS_COMMAND = "opencode";
export const OSS_CONFIG_DIR_ENV = "OPENCODE_CONFIG_DIR";
export const OSS_CONFIG_DIR_NAME = "oss-config";
export const OSS_CONFIG_FILE_NAME = "opencode.json";
export const OSS_KEY_FILE_ENV = "LOOP_OSS_API_KEY_FILE";
export const OSS_PROVIDER_KEY_ENV = "OPENROUTER_API_KEY";
export const OSS_CONFIG_SCHEMA = "https://opencode.ai/config.json";

const DEFAULT_OSS_KEY_FILE = join(
  homedir(),
  ".config",
  "loop",
  "openrouter.key"
);
const FILE_MODE_DIVISOR = 0o1000;
const REQUIRED_KEY_FILE_MODE = 0o600;
const SESSION_ID_KEYS = ["sessionID", "sessionId", "session_id"] as const;

export interface OssPermissionPolicy {
  bash: string;
  edit: string;
  webfetch: string;
}

// Explicit, written-down policy. A full agent seat needs edit and bash to do
// real work; outbound fetch stays denied so the seat cannot quietly reach the
// network outside its declared provider.
export const OSS_PERMISSION_POLICY: OssPermissionPolicy = {
  bash: "allow",
  edit: "allow",
  webfetch: "deny",
};

interface OssMcpServerConfig {
  command: string[];
  enabled: boolean;
  type: "local";
}

export interface OssRunConfig {
  $schema: string;
  mcp: Record<string, OssMcpServerConfig>;
  permission: OssPermissionPolicy;
}

export const buildOssBridgeServerConfig = (
  runDir: string,
  launchArgv: string[] = buildLaunchArgv()
): OssMcpServerConfig => ({
  command: [...launchArgv, BRIDGE_SUBCOMMAND, runDir, "oss"],
  enabled: true,
  type: "local",
});

// Exactly one MCP server — this run's bridge — plus an explicit permission
// policy. No credential value is ever written here.
export const buildOssRunConfig = (
  runDir: string,
  launchArgv: string[] = buildLaunchArgv()
): OssRunConfig => ({
  $schema: OSS_CONFIG_SCHEMA,
  mcp: {
    [BRIDGE_SERVER]: buildOssBridgeServerConfig(runDir, launchArgv),
  },
  permission: { ...OSS_PERMISSION_POLICY },
});

export const ossConfigDirPath = (runDir: string): string =>
  join(runDir, OSS_CONFIG_DIR_NAME);

export const ossConfigFilePath = (runDir: string): string =>
  join(ossConfigDirPath(runDir), OSS_CONFIG_FILE_NAME);

export const ensureOssConfig = (
  runDir: string,
  launchArgv: string[] = buildLaunchArgv()
): string => {
  const directory = ossConfigDirPath(runDir);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const path = join(directory, OSS_CONFIG_FILE_NAME);
  writeFileSync(
    path,
    `${JSON.stringify(buildOssRunConfig(runDir, launchArgv), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(path, 0o600);
  return directory;
};

// Run-scoped configuration directory. Without this the seat inherits whatever
// MCP servers the user configured globally.
export const ossConfigEnv = (
  configDir: string | undefined
): NodeJS.ProcessEnv => (configDir ? { [OSS_CONFIG_DIR_ENV]: configDir } : {});

export interface OssCredentialResolution {
  env: NodeJS.ProcessEnv;
  reason: string;
  source: "key-file" | "provider-native";
}

const keyFileModeIsPrivate = (path: string): boolean => {
  const stat = statSync(path);
  return (
    stat.isFile() && stat.mode % FILE_MODE_DIVISOR === REQUIRED_KEY_FILE_MODE
  );
};

// The provider key never reaches prompts, manifests, argv, traces, or any
// repository file. It is either already present in the provider-native
// lookup path (opencode auth / ambient environment), or read here from a
// mode-0600 file and handed to the child process through its environment.
export const resolveOssCredentialEnv = (
  env: NodeJS.ProcessEnv
): OssCredentialResolution => {
  const configuredPath = env[OSS_KEY_FILE_ENV];
  if (configuredPath === "") {
    return {
      env: {},
      reason: "key file loading is disabled",
      source: "provider-native",
    };
  }
  const path = configuredPath?.trim() || DEFAULT_OSS_KEY_FILE;
  let usable = false;
  try {
    usable = keyFileModeIsPrivate(path);
  } catch {
    return {
      env: {},
      reason: `key file unavailable: ${path}`,
      source: "provider-native",
    };
  }
  if (!usable) {
    return {
      env: {},
      reason: `key file ignored: ${path} must be a regular file with mode 0600`,
      source: "provider-native",
    };
  }
  const key = readFileSync(path, "utf8").trim();
  if (!key) {
    return {
      env: {},
      reason: `key file empty: ${path}`,
      source: "provider-native",
    };
  }
  return {
    env: { [OSS_PROVIDER_KEY_ENV]: key },
    reason: `key file loaded: ${path}`,
    source: "key-file",
  };
};

export interface OssRunArgsInput {
  // Any non-empty OpenCode provider/model identifier, passed through unchanged.
  model: string;
  prompt?: string;
  // Present only when resuming: OpenCode rejects an unknown --session id, so a
  // first turn must run without one and persist the id it reports.
  sessionId?: string;
  title?: string;
}

export const buildOssRunArgs = ({
  model,
  prompt,
  sessionId,
  title,
}: OssRunArgsInput): string[] => {
  const args = ["run", "--format", "json", "--model", model];
  if (sessionId) {
    args.push("--session", sessionId);
  } else if (title) {
    args.push("--title", title);
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

export const ossSessionTitle = (runId: string): string => `loop-${runId}`;

// OpenCode assigns the session id itself and rejects an unknown --session, so
// the id is captured from the JSON event stream and persisted for resume.
let lastOssSessionId = "";

export const getLastOssSessionId = (): string => lastOssSessionId;

export const setLastOssSessionId = (value: string): void => {
  lastOssSessionId = value;
};

export const resetLastOssSessionId = (): void => {
  lastOssSessionId = "";
};

export type OssSessionLookup = (
  argv: string[],
  env: NodeJS.ProcessEnv
) => string | undefined;

export const buildOssSessionListArgs = (maxCount = 50): string[] => [
  "session",
  "list",
  "--format",
  "json",
  "-n",
  String(maxCount),
];

const sessionEntries = (parsed: unknown): Record<string, unknown>[] => {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object"
    );
  }
  if (parsed && typeof parsed === "object") {
    return sessionEntries((parsed as Record<string, unknown>).sessions);
  }
  return [];
};

// A tmux pane writes its JSON events to the terminal, not to this process, so
// the pane's session id is recovered by title instead. The listing shape was
// only observed empty on opencode 1.4.3, so this parser accepts either a bare
// array or a { sessions: [...] } envelope and returns undefined rather than
// guessing when neither matches.
export const parseOssSessionListing = (
  text: string,
  title: string
): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  for (const entry of sessionEntries(parsed)) {
    const entryTitle = entry.title;
    const id = entry.id;
    if (
      typeof entryTitle === "string" &&
      entryTitle.trim() === title &&
      typeof id === "string" &&
      id.trim()
    ) {
      return id.trim();
    }
  }
  return undefined;
};

const sessionIdFromRecord = (
  record: Record<string, unknown>
): string | undefined => {
  for (const key of SESSION_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const info = record.info;
  if (info && typeof info === "object") {
    const id = (info as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
};

// OpenCode emits bus events as {"type": "...", "properties": {...}} on
// --format json. Session identity shows up as properties.info.id for
// session.* events and as a sessionID field on message.* events, so accept
// either rather than binding to one event name.
export const parseOssSessionId = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const direct = sessionIdFromRecord(record);
  if (direct) {
    return direct;
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    return sessionIdFromRecord(properties as Record<string, unknown>);
  }
  return undefined;
};

// Resume-time resolution. A tmux pane's JSON events go to the terminal, not to
// this process, so a session started in a previous tmux run is recovered by the
// title the launch gave it. A stored id always wins; a failed lookup returns ""
// and the next turn simply starts a fresh session rather than blocking launch.
export const resolveOssSessionId = (
  storedSessionId: string | undefined,
  title: string,
  lookup: OssSessionLookup,
  env: NodeJS.ProcessEnv,
  configDir?: string
): string => {
  const stored = storedSessionId?.trim();
  if (stored) {
    return stored;
  }
  const text = lookup(buildOssSessionListArgs(), {
    ...env,
    ...ossConfigEnv(configDir),
  });
  if (!text) {
    return "";
  }
  return parseOssSessionListing(text, title) ?? "";
};

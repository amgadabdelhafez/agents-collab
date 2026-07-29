import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
} from "./constants";
import {
  CODEX_NATIVE_FALLBACK_PROFILE,
  type NativeSubagentMode,
  resolveNativeSubagentMode,
} from "./native-subagent";

const LOOP_CODEX_HOME_DIR = "codex-home";
const AUTH_FILES = ["auth.json"] as const;

const loopCodexFallbackAgentPath = (codexHome: string): string =>
  join(codexHome, "agents", `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`);

const removeFiles = (paths: string[]): void => {
  for (const path of paths) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
};

const removeLoopCodexFallbackAgent = (codexHome: string): void =>
  removeFiles([loopCodexFallbackAgentPath(codexHome)]);

const removeLoopCodexGovernance = (codexHome: string): void =>
  removeFiles([
    join(codexHome, "hooks.json"),
    loopCodexFallbackAgentPath(codexHome),
  ]);

const sourceCodexHome = (): string | undefined => {
  if (process.env.CODEX_HOME?.trim()) {
    return process.env.CODEX_HOME;
  }
  if (process.env.HOME?.trim()) {
    return join(process.env.HOME, ".codex");
  }
  return undefined;
};

const tomlKey = (value: string): string => JSON.stringify(value);

export const buildLoopCodexConfig = (
  cwd: string,
  mode: NativeSubagentMode = "utility-first"
): string => {
  const agents =
    mode === "off"
      ? []
      : [
          "[agents]",
          // Codex 0.145 reapplies the parent turn's live sandbox after loading
          // a custom role. Because this parent must retain write authority, no
          // Codex child can be proven read-only. Keep native agents disabled
          // in both governed modes; utility-first's one fallback is currently
          // the enforceable Claude profile.
          "enabled = false",
          "",
        ];
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    `model = ${JSON.stringify(DEFAULT_CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(
      DEFAULT_CODEX_REASONING_EFFORT
    )}`,
    `service_tier = ${JSON.stringify(DEFAULT_CODEX_SERVICE_TIER)}`,
    "",
    ...agents,
    `[projects.${tomlKey(cwd)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n");
};

const ensureAuthFile = (codexHome: string, filename: string): void => {
  const sourceHome = sourceCodexHome();
  if (!sourceHome) {
    return;
  }
  const source = join(sourceHome, filename);
  const target = join(codexHome, filename);
  if (!existsSync(source) || existsSync(target)) {
    return;
  }
  try {
    if (lstatSync(source).isFile()) {
      symlinkSync(source, target);
    }
  } catch {
    try {
      copyFileSync(source, target);
    } catch {
      // Codex will report an auth error if no reusable auth file is available.
    }
  }
};

export const ensureLoopCodexHome = (
  runDir: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): string => {
  const codexHome = join(runDir, LOOP_CODEX_HOME_DIR);
  const mode = resolveNativeSubagentMode(env.LOOP_NATIVE_SUBAGENT_MODE);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    buildLoopCodexConfig(cwd, mode),
    "utf8"
  );
  if (mode === "utility-first" || mode === "strict") {
    // Remove profiles written by older builds. Codex 0.145 custom agents
    // inherit this parent's danger-full-access sandbox, so retaining the file
    // would advertise a read-only boundary that the provider does not enforce.
    // Keep hooks.json in either governed mode: an already-running app-server
    // loaded that root spawn gate at startup, and live reattachment must not
    // erase it.
    removeLoopCodexFallbackAgent(codexHome);
  } else {
    // A run-scoped CODEX_HOME survives topology changes. Foreground/off and
    // compatibility startup must not inherit hooks or a child profile written
    // by an earlier governed tmux launch.
    removeLoopCodexGovernance(codexHome);
  }
  for (const filename of AUTH_FILES) {
    ensureAuthFile(codexHome, filename);
  }
  return codexHome;
};

export const codexHomeEnv = (
  codexHome: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv | undefined =>
  codexHome ? { ...baseEnv, CODEX_HOME: codexHome } : undefined;

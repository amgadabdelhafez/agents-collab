import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
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
          `enabled = ${mode === "strict" ? "false" : "true"}`,
          ...(mode === "utility-first"
            ? ["max_concurrent_threads_per_session = 1"]
            : []),
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

export const buildLoopCodexFallbackAgent = (): string =>
  // Standalone agent layers must declare a transport even for a disabled MCP
  // server; use an inert loopback URL so the layer parses before parent merge.
  [
    `name = ${JSON.stringify(CODEX_NATIVE_FALLBACK_PROFILE)}`,
    'description = "Governess-leased read-only explorer or independent reviewer."',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    "allow_login_shell = false",
    'web_search = "disabled"',
    'developer_instructions = """',
    "Inspect only the exact scopes and objective injected by the Governess lease.",
    "Do not write, edit, mutate, use network or MCP tools, ask the human, make authority decisions, or spawn descendants.",
    "Use only absolute system binaries and canonical absolute file operands with login=false and workdir set to the canonical repository root shown in the lease context. Allowed forms (maximum 500 lines, eight files, and 1 MiB per file): /usr/bin/sed -n '1,120p' /repo/path; /usr/bin/head -n 120 -- /repo/path; /usr/bin/tail -n 120 -- /repo/path; /usr/bin/wc -l -- /repo/path; or /usr/bin/stat -- /repo/path.",
    "The Governess hook rejects PATH-resolved executables, login shells, noncanonical workdirs or operands, recursive directory operands, compound commands, expansion, redirection, unscoped paths, symlink escapes, and every other executable. Cite concrete file evidence, return a concise result to the parent, and stop.",
    '"""',
    "",
    "[agents]",
    "enabled = false",
    "",
    "[features]",
    "multi_agent = false",
    "remote_plugin = false",
    "shell_tool = true",
    "unified_exec = false",
    "",
    "[tools]",
    "view_image = false",
    "web_search = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'set = { PATH = "/usr/bin:/bin", LC_ALL = "C" }',
    "ignore_default_excludes = false",
    "experimental_use_profile = false",
    "",
    "[mcp_servers.loop-bridge]",
    'url = "http://127.0.0.1:1/mcp"',
    "enabled = false",
    "",
  ].join("\n");

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
  if (mode === "utility-first") {
    const agentsDir = join(codexHome, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`),
      buildLoopCodexFallbackAgent(),
      "utf8"
    );
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

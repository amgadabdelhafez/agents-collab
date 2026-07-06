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

const buildLoopCodexConfig = (cwd: string): string =>
  [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    `model = ${JSON.stringify(DEFAULT_CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(
      DEFAULT_CODEX_REASONING_EFFORT
    )}`,
    `service_tier = ${JSON.stringify(DEFAULT_CODEX_SERVICE_TIER)}`,
    "",
    `[projects.${tomlKey(cwd)}]`,
    'trust_level = "trusted"',
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
  cwd = process.cwd()
): string => {
  const codexHome = join(runDir, LOOP_CODEX_HOME_DIR);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    buildLoopCodexConfig(cwd),
    "utf8"
  );
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

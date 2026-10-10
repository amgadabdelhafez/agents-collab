// fix8: the A2A V2 secrets file `loop orchestration a2a-v2 init` writes next to
// the orchestration config. It holds the ledger database URL and the result
// graph key under the variable names the config's a2aV2 section names. It is
// the only place either secret is written: never argv, never a log line,
// never the config itself.

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SQL } from "bun";

export const A2A_V2_ENV_FILE = "a2a-v2.env";
export const A2A_V2_DATABASE_URL_ENV = "LOOP_A2A_V2_DATABASE_URL";
export const A2A_V2_RESULT_GRAPH_KEY_ENV = "LOOP_A2A_V2_RESULT_GRAPH_KEY";
const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const OWNER_ONLY_MASK = 0o077;

export const a2aV2EnvFilePath = (configPath: string): string =>
  join(dirname(configPath), A2A_V2_ENV_FILE);

/** `NAME=value` lines; blank lines and `#` comments are skipped. */
export const parseA2AV2EnvFile = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    const name = equals > 0 ? line.slice(0, equals) : "";
    if (!NAME_RE.test(name)) {
      throw new Error("A2A V2 env file has a malformed line");
    }
    values.set(name, line.slice(equals + 1));
  }
  return values;
};

export const formatA2AV2EnvFile = (values: ReadonlyMap<string, string>) =>
  `# Written by loop orchestration a2a-v2 init. Secrets: keep mode 0600.\n${[
    ...values,
  ]
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;

export type A2AV2EnvFileRead =
  | { kind: "absent" }
  | { kind: "refused"; reason: string }
  | { kind: "read"; values: Map<string, string> };

/**
 * Reads the env file only when it is a regular, non-symlink file readable by
 * its owner alone. A group- or world-readable file is refused, not repaired:
 * its secrets may already have been read.
 */
export const readA2AV2EnvFile = (path: string): A2AV2EnvFileRead => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === "ENOENT"
      ? { kind: "absent" }
      : {
          kind: "refused",
          reason: `${path} cannot be opened (${String(code)})`,
        };
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return { kind: "refused", reason: `${path} is not a regular file` };
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
    if ((stat.mode & OWNER_ONLY_MASK) !== 0) {
      return {
        kind: "refused",
        reason: `${path} is readable by group or others; chmod 600 it and rotate what it holds`,
      };
    }
    try {
      return {
        kind: "read",
        values: parseA2AV2EnvFile(readFileSync(descriptor, "utf8")),
      };
    } catch (error) {
      return {
        kind: "refused",
        reason: `${path}: ${error instanceof Error ? error.message : "unreadable"}`,
      };
    }
  } finally {
    closeSync(descriptor);
  }
};

/**
 * The environment with the config's A2A V2 env file folded in underneath it:
 * a variable already set in `env` wins. Reports a refused file through `log`
 * (path and reason only) and returns `env` unchanged.
 */
export const withA2AV2EnvFile = (
  configPath: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = () => undefined
): NodeJS.ProcessEnv => {
  const read = readA2AV2EnvFile(a2aV2EnvFilePath(configPath));
  if (read.kind === "refused") {
    log(`A2A V2 env file ignored: ${read.reason}`);
    return env;
  }
  if (read.kind === "absent") {
    return env;
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of read.values) {
    if (merged[name] === undefined) {
      merged[name] = value;
    }
  }
  return merged;
};

export const A2A_V2_DATABASE_PROBE_TIMEOUT_MS = 5000;

/**
 * Whether the ledger database answers `SELECT 1` within the bound. Never
 * throws and never reports the URL or the driver's error (which may carry it).
 */
export const probeA2AV2Database = async (
  databaseUrl: string,
  timeoutMs: number = A2A_V2_DATABASE_PROBE_TIMEOUT_MS
): Promise<boolean> => {
  let sql: SQL | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    sql = new SQL(databaseUrl);
    const client = sql;
    return await Promise.race([
      (async () => {
        await client`SELECT 1`;
        return true;
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await sql?.close({ timeout: 0 }).catch(() => undefined);
  }
};

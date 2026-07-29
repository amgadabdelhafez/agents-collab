import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import type { BridgeMcpSource } from "./bridge";
import type { RunManifest } from "./run-state";

const PROCESS_REGISTRY_DIR = "run-processes";
const BRIDGE_PROCESS_PREFIX = "bridge-";
const WHITESPACE_RE = /\s+/;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

interface RegisteredBridgeProcess {
  kind: "bridge-mcp";
  pid: number;
  runDir: string;
  source: BridgeMcpSource;
}

export interface RunProcessCleanupResult {
  killed: number[];
  skipped: Array<{ pid: number; reason: string }>;
}

interface RunProcessCleanupDeps {
  commandForPid: (pid: number) => string | undefined;
  listeningPids: (port: number) => number[];
  signal: (pid: number, signal: NodeJS.Signals) => void;
}

const decode = (value: string | Uint8Array | undefined): string => {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : new TextDecoder().decode(value);
};

const defaultCommandForPid = (pid: number): string | undefined => {
  const result = spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const command = decode(result.stdout).trim();
  return result.exitCode === 0 && command ? command : undefined;
};

const defaultListeningPids = (port: number): number[] => {
  const result = spawnSync(
    ["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return decode(result.stdout)
    .split(WHITESPACE_RE)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const cleanupDeps: RunProcessCleanupDeps = {
  commandForPid: defaultCommandForPid,
  listeningPids: defaultListeningPids,
  signal: (pid, signal) => process.kill(pid, signal),
};

const registryDir = (runDir: string): string =>
  join(runDir, PROCESS_REGISTRY_DIR);

const bridgeRegistrationPath = (runDir: string, pid: number): string =>
  join(registryDir(runDir), `${BRIDGE_PROCESS_PREFIX}${pid}.json`);

export const registerRunBridgeProcess = (
  runDir: string,
  source: BridgeMcpSource,
  pid = process.pid
): string => {
  const path = bridgeRegistrationPath(runDir, pid);
  mkdirSync(registryDir(runDir), { recursive: true });
  const record: RegisteredBridgeProcess = {
    kind: "bridge-mcp",
    pid,
    runDir,
    source,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
};

export const unregisterRunBridgeProcess = (path: string): void => {
  rmSync(path, { force: true });
};

const readBridgeRegistrations = (
  runDir: string
): Array<{ path: string; record: RegisteredBridgeProcess }> => {
  let files: string[];
  try {
    files = readdirSync(registryDir(runDir));
  } catch {
    return [];
  }
  const registrations: Array<{
    path: string;
    record: RegisteredBridgeProcess;
  }> = [];
  for (const file of files) {
    if (!(file.startsWith(BRIDGE_PROCESS_PREFIX) && file.endsWith(".json"))) {
      continue;
    }
    const path = join(registryDir(runDir), file);
    try {
      const record = JSON.parse(
        readFileSync(path, "utf8")
      ) as RegisteredBridgeProcess;
      if (
        record.kind === "bridge-mcp" &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.runDir === runDir
      ) {
        registrations.push({ path, record });
      }
    } catch {
      // Malformed ownership records are never trusted as kill authority.
    }
  }
  return registrations;
};

const appServerPort = (remoteUrl: string | undefined): number | undefined => {
  if (!remoteUrl) {
    return undefined;
  }
  try {
    const port = Number.parseInt(new URL(remoteUrl).port, 10);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
};

const commandHasExactArg = (command: string, argument: string): boolean => {
  const escaped = argument.replace(REGEX_META_RE, "\\$&");
  return new RegExp(`(?:^|\\s|['"])${escaped}(?=$|\\s|['"])`).test(command);
};

const signalOwnedProcess = (
  result: RunProcessCleanupResult,
  pid: number,
  valid: boolean,
  reason: string
): void => {
  if (!valid) {
    result.skipped.push({ pid, reason });
    return;
  }
  try {
    cleanupDeps.signal(pid, "SIGTERM");
    result.killed.push(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      result.skipped.push({
        pid,
        reason: `signal-failed:${code ?? "unknown"}`,
      });
    }
  }
};

export const cleanupRunOwnedProcesses = (
  runDir: string,
  manifest: RunManifest | undefined
): RunProcessCleanupResult => {
  const result: RunProcessCleanupResult = { killed: [], skipped: [] };
  for (const { path, record } of readBridgeRegistrations(runDir)) {
    const command = cleanupDeps.commandForPid(record.pid);
    signalOwnedProcess(
      result,
      record.pid,
      Boolean(
        command?.includes("__bridge-mcp") &&
          commandHasExactArg(command, record.runDir)
      ),
      command ? "bridge-command-mismatch" : "bridge-not-running"
    );
    rmSync(path, { force: true });
  }

  const appServerPid = manifest?.codexAppServerPid;
  const port = appServerPort(manifest?.codexRemoteUrl);
  if (appServerPid) {
    const command = cleanupDeps.commandForPid(appServerPid);
    const ownsListener = Boolean(
      port && cleanupDeps.listeningPids(port).includes(appServerPid)
    );
    signalOwnedProcess(
      result,
      appServerPid,
      Boolean(command?.includes("app-server") && ownsListener),
      command ? "app-server-identity-mismatch" : "app-server-not-running"
    );
  }
  return result;
};

export const runProcessCleanupInternals = {
  deps: cleanupDeps,
};

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
import {
  buildManifestPath,
  isActiveRunState,
  type RunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
  setRunManifestState,
  updateRunManifest,
} from "./run-state";

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
  listTmuxSessions: () => ReadonlySet<string> | undefined;
  pidAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  updateManifest: typeof updateRunManifest;
}

export interface AbandonedRunCleanupResult extends RunProcessCleanupResult {
  cleaned: number;
  kept: number;
  scanned: number;
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

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultListTmuxSessions = (): ReadonlySet<string> | undefined => {
  try {
    const result = spawnSync(
      ["tmux", "list-sessions", "-F", "#{session_name}"],
      {
        killSignal: "SIGKILL",
        stderr: "pipe",
        stdout: "pipe",
        timeout: 750,
      }
    );
    if (result.signalCode) {
      return undefined;
    }
    if (result.exitCode === 0) {
      return new Set(
        decode(result.stdout).split(WHITESPACE_RE).filter(Boolean)
      );
    }
    return decode(result.stderr).includes("no server running")
      ? new Set()
      : undefined;
  } catch {
    return undefined;
  }
};

const cleanupDeps: RunProcessCleanupDeps = {
  commandForPid: defaultCommandForPid,
  listTmuxSessions: defaultListTmuxSessions,
  listeningPids: defaultListeningPids,
  pidAlive: defaultPidAlive,
  signal: (pid, signal) => process.kill(pid, signal),
  updateManifest: updateRunManifest,
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
  reason: string,
  signal: RunProcessCleanupDeps["signal"]
): boolean => {
  if (!valid) {
    result.skipped.push({ pid, reason });
    return false;
  }
  try {
    signal(pid, "SIGTERM");
    result.killed.push(pid);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      result.skipped.push({
        pid,
        reason: `signal-failed:${code ?? "unknown"}`,
      });
      return true;
    }
    return false;
  }
};

const cleanupRunOwnedProcessesWithDeps = (
  runDir: string,
  manifest: RunManifest | undefined,
  deps: RunProcessCleanupDeps
): RunProcessCleanupResult => {
  const result: RunProcessCleanupResult = { killed: [], skipped: [] };
  for (const { path, record } of readBridgeRegistrations(runDir)) {
    const command = deps.commandForPid(record.pid);
    const retainRegistration = signalOwnedProcess(
      result,
      record.pid,
      Boolean(
        command?.includes("__bridge-mcp") &&
          commandHasExactArg(command, record.runDir)
      ),
      command ? "bridge-command-mismatch" : "bridge-not-running",
      deps.signal
    );
    if (!retainRegistration) {
      rmSync(path, { force: true });
    }
  }

  const appServerPid = manifest?.codexAppServerPid;
  const port = appServerPort(manifest?.codexRemoteUrl);
  if (appServerPid) {
    const command = deps.commandForPid(appServerPid);
    const appServerCommand = Boolean(command?.includes("app-server"));
    const ownsListener = Boolean(
      appServerCommand &&
        port &&
        deps.listeningPids(port).includes(appServerPid)
    );
    signalOwnedProcess(
      result,
      appServerPid,
      appServerCommand && ownsListener,
      command ? "app-server-identity-mismatch" : "app-server-not-running",
      deps.signal
    );
  }
  return result;
};

export const cleanupRunOwnedProcesses = (
  runDir: string,
  manifest: RunManifest | undefined
): RunProcessCleanupResult =>
  cleanupRunOwnedProcessesWithDeps(runDir, manifest, cleanupDeps);

const runIsProvablyAbandoned = (
  manifest: RunManifest,
  liveTmuxSessions: ReadonlySet<string> | undefined,
  deps: RunProcessCleanupDeps
): boolean => {
  if (isActiveRunState(manifest.state) && !manifest.tmuxSession) {
    // Detached workspaces outlive their launcher PID. An active manifest with
    // missing topology is corrupt/unknown and must be preserved for repair.
    return false;
  }
  if (
    manifest.tmuxSession &&
    (!liveTmuxSessions || liveTmuxSessions.has(manifest.tmuxSession))
  ) {
    return false;
  }
  return !deps.pidAlive(manifest.pid);
};

const cleanupAbandonedRun = (input: {
  deps: RunProcessCleanupDeps;
  liveTmuxSessions: ReadonlySet<string> | undefined;
  manifest: RunManifest;
  manifestPath: string;
  runDir: string;
}): RunProcessCleanupResult | undefined => {
  const hasProcessEvidence = Boolean(
    input.manifest.codexAppServerPid ||
      readBridgeRegistrations(input.runDir).length > 0
  );
  const needsStateRepair = isActiveRunState(input.manifest.state);
  if (
    !(
      (hasProcessEvidence || needsStateRepair) &&
      runIsProvablyAbandoned(input.manifest, input.liveTmuxSessions, input.deps)
    )
  ) {
    return undefined;
  }
  if (needsStateRepair) {
    input.deps.updateManifest(input.manifestPath, (current) =>
      current ? setRunManifestState(current, "failed") : undefined
    );
  }
  if (!hasProcessEvidence) {
    return { killed: [], skipped: [] };
  }
  const cleanup = cleanupRunOwnedProcessesWithDeps(
    input.runDir,
    input.manifest,
    input.deps
  );
  const retainAppServerOwnership = cleanup.skipped.some(
    (entry) =>
      entry.pid === input.manifest.codexAppServerPid &&
      entry.reason.startsWith("signal-failed:")
  );
  input.deps.updateManifest(input.manifestPath, (current) => {
    if (!current) {
      return undefined;
    }
    const withoutSettledOwnership = retainAppServerOwnership
      ? current
      : {
          ...current,
          codexAppServerPid: undefined,
          codexRemoteUrl: undefined,
        };
    return withoutSettledOwnership;
  });
  return cleanup;
};

const inspectStoredRun = (input: {
  deps: RunProcessCleanupDeps;
  liveTmuxSessions: ReadonlySet<string> | undefined;
  repoId: string;
  runDir: string;
  runId: string;
}): { cleanup?: RunProcessCleanupResult; scanned: boolean } => {
  const manifestPath = buildManifestPath(input.runDir);
  const manifest = readRunManifest(manifestPath);
  if (
    !(
      manifest &&
      manifest.repoId === input.repoId &&
      manifest.runId === input.runId
    )
  ) {
    return { scanned: false };
  }
  return {
    cleanup: cleanupAbandonedRun({
      deps: input.deps,
      liveTmuxSessions: input.liveTmuxSessions,
      manifest,
      manifestPath,
      runDir: input.runDir,
    }),
    scanned: true,
  };
};

const collectStoredRunCleanup = (input: {
  deps: RunProcessCleanupDeps;
  entries: string[];
  liveTmuxSessions: ReadonlySet<string> | undefined;
  log: (line: string) => void;
  repoId: string;
  repoRuns: string;
}): AbandonedRunCleanupResult => {
  const result: AbandonedRunCleanupResult = {
    cleaned: 0,
    kept: 0,
    killed: [],
    scanned: 0,
    skipped: [],
  };
  for (const runId of input.entries) {
    const runDir = join(input.repoRuns, runId);
    try {
      const inspected = inspectStoredRun({
        deps: input.deps,
        liveTmuxSessions: input.liveTmuxSessions,
        repoId: input.repoId,
        runDir,
        runId,
      });
      if (inspected.scanned) {
        result.scanned += 1;
      }
      if (!inspected.cleanup) {
        result.kept += 1;
        continue;
      }
      result.killed.push(...inspected.cleanup.killed);
      result.skipped.push(...inspected.cleanup.skipped);
      result.cleaned += 1;
    } catch (error) {
      result.kept += 1;
      input.log(
        `[loop] abandoned-run cleanup skipped run "${runId}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return result;
};

export const gcAbandonedRunProcesses = (
  options: {
    cwd?: string;
    deps?: Partial<RunProcessCleanupDeps>;
    home?: string;
    log?: (line: string) => void;
    repoId?: string;
    storageRoot?: string;
  } = {}
): AbandonedRunCleanupResult => {
  const deps = { ...cleanupDeps, ...options.deps };
  const cwd = options.cwd ?? process.cwd();
  const repoId = options.repoId ?? resolveRepoId(cwd);
  const storageRoot =
    options.storageRoot ?? resolveStorageRoot(options.home ?? process.env.HOME);
  const repoRuns = join(storageRoot, repoId);
  const log = options.log ?? console.error;
  let entries: string[];
  try {
    entries = readdirSync(repoRuns, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true })
      );
  } catch {
    return { cleaned: 0, kept: 0, killed: [], scanned: 0, skipped: [] };
  }
  let liveTmuxSessions: ReadonlySet<string> | undefined;
  try {
    liveTmuxSessions = deps.listTmuxSessions();
  } catch (error) {
    log(
      `[loop] abandoned-run cleanup could not inspect tmux; preserving tmux-owned runs: ${error instanceof Error ? error.message : String(error)}`
    );
    liveTmuxSessions = undefined;
  }
  const result = collectStoredRunCleanup({
    deps,
    entries,
    liveTmuxSessions,
    log,
    repoId,
    repoRuns,
  });
  if (result.cleaned > 0) {
    log(
      `[loop] cleaned ${result.cleaned} abandoned run${result.cleaned === 1 ? "" : "s"} for "${repoId}" (${result.killed.length} process${result.killed.length === 1 ? "" : "es"} signaled)`
    );
  }
  return result;
};

export const runProcessCleanupInternals = {
  deps: cleanupDeps,
};

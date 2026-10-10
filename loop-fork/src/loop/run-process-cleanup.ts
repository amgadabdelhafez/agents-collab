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
  BRIDGE_SUBCOMMAND,
  BRIDGE_WORKER_SUBCOMMAND,
} from "./bridge-constants";
import { tmuxRuntimeAbsentForManifestSync } from "./launch-reservation";
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
import { UTILITY_WORKER_SUBCOMMAND } from "./utility-constants";
import {
  readUtilityJobsAsEvidence,
  type UtilityJobSnapshot,
} from "./utility-store";

const PROCESS_REGISTRY_DIR = "run-processes";
const BRIDGE_WORKER_FILE = "bridge-worker.json";
const BRIDGE_PROCESS_PREFIX = "bridge-";
const WHITESPACE_RE = /\s+/;

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
  now: () => string;
  pidAlive: (pid: number) => boolean;
  /**
   * Whether the run's tmux runtime is positively gone on the run's own
   * server: its recorded socket, or every legacy candidate socket when it
   * recorded none. The same rule as `loop reconcile` and the launch scan.
   */
  runtimeAbsent: (manifestPath: string) => boolean;
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
  now: () => new Date().toISOString(),
  pidAlive: defaultPidAlive,
  runtimeAbsent: (manifestPath) =>
    tmuxRuntimeAbsentForManifestSync(manifestPath),
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

/**
 * `ps -o command=` joins argv with single spaces, so a runDir containing
 * spaces cannot be recovered by splitting, and a bare substring match also
 * accepts another run whose directory merely starts with this one. Both
 * bridge processes are spawned with the run directory in a fixed trailing
 * position (`<subcommand> <runDir> [source]`), so only that exact tail proves
 * ownership; anything else is left unsignaled.
 */
const commandEndsWithArgs = (command: string, args: string[]): boolean => {
  const trimmed = command.trimEnd();
  const tail = args.join(" ");
  return trimmed === tail || trimmed.endsWith(` ${tail}`);
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

/** The pid `bridge-worker.json` names, or `undefined` when it names none. */
const readBridgeWorkerPid = (runDir: string): number | undefined => {
  try {
    const pid = (
      JSON.parse(readFileSync(join(runDir, BRIDGE_WORKER_FILE), "utf8")) as {
        pid?: unknown;
      } | null
    )?.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
      ? pid
      : undefined;
  } catch {
    // Absent or malformed: never kill authority.
    return undefined;
  }
};

/**
 * Ends the run's bridge worker. It is spawned detached, so the session kill
 * never reaches it, and between wakes it sleeps up to the reconciliation
 * heartbeat; left alone it outlives the teardown as a live recorded process
 * and blocks the workspace handback. It is signalled only when the live
 * process is provably this run's worker: its live argv ends with exactly the
 * worker subcommand and this run directory (r6's exact-tail rule, so a run
 * directory that merely prefixes another, or contains spaces, never matches).
 * The record is kept, since a dead pid is absence evidence for the release
 * check.
 */
const signalRunBridgeWorker = (
  result: RunProcessCleanupResult,
  runDir: string,
  deps: RunProcessCleanupDeps
): void => {
  const pid = readBridgeWorkerPid(runDir);
  if (pid === undefined) {
    return;
  }
  const command = deps.commandForPid(pid);
  signalOwnedProcess(
    result,
    pid,
    Boolean(
      command &&
        commandEndsWithArgs(command, [BRIDGE_WORKER_SUBCOMMAND, runDir])
    ),
    command ? "bridge-worker-command-mismatch" : "bridge-worker-not-running",
    deps.signal
  );
};

/**
 * Ends every live utility worker (Direct, Nanny, Au Pair) the run ever
 * claimed a job with. Workers are spawned detached with their cwd in the
 * workspace, so the session kill never reaches them and their pid is recorded
 * only in the job claim. Every claim event counts, not only a job's latest
 * claim: a worker fenced off by a later claim of the same job may still be
 * alive, and the release evidence counts it too. A worker is signalled only
 * when its live argv ends with exactly the worker subcommand, this run
 * directory, the claim epoch and the job id (r6's exact-tail rule). Its process group goes with
 * it (bounded commands it runs are in that group); a worker that leads no
 * group is signalled alone. The claims are kept, since a dead pid is absence
 * evidence for the release check. A torn final append is skipped here (it
 * names no pid that can be read); the release check judges it.
 */
const signalRunUtilityWorkers = (
  result: RunProcessCleanupResult,
  runDir: string,
  deps: RunProcessCleanupDeps
): void => {
  let jobs: UtilityJobSnapshot[];
  try {
    jobs = readUtilityJobsAsEvidence(runDir).jobs;
  } catch (error) {
    // Never kill authority. The release check reads the same journal as
    // unreadable and keeps the workspace owned.
    result.skipped.push({
      pid: 0,
      reason: `utility-jobs-unreadable: ${(error as Error).message}`,
    });
    return;
  }
  const seen = new Set<string>();
  for (const job of jobs) {
    for (const event of job.events) {
      const claim = event.claim;
      const key = claim && `${claim.workerPid}:${claim.epoch}:${job.jobId}`;
      if (!(claim && key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      signalUtilityWorker(result, runDir, job.jobId, claim, deps);
    }
  }
};

const signalUtilityWorker = (
  result: RunProcessCleanupResult,
  runDir: string,
  jobId: string,
  claim: { epoch: number; workerPid: number },
  deps: RunProcessCleanupDeps
): void => {
  const pid = claim.workerPid;
  if (!deps.pidAlive(pid)) {
    return;
  }
  const command = deps.commandForPid(pid);
  // Spawned as `<loop> __utility-worker <runDir> <epoch> <jobId>`: only that
  // exact argv tail proves ownership (a spaced or prefixing run directory
  // never matches).
  const owned = Boolean(
    command &&
      commandEndsWithArgs(command, [
        UTILITY_WORKER_SUBCOMMAND,
        runDir,
        String(claim.epoch),
        jobId,
      ])
  );
  if (!owned) {
    result.skipped.push({
      pid,
      reason: command
        ? "utility-worker-command-mismatch"
        : "utility-worker-not-running",
    });
    return;
  }
  try {
    deps.signal(-pid, "SIGTERM");
    result.killed.push(pid);
    return;
  } catch {
    // Not a process-group leader: signal the worker alone below.
  }
  signalOwnedProcess(result, pid, true, "", deps.signal);
};

const cleanupRunOwnedProcessesWithDeps = (
  runDir: string,
  manifest: RunManifest | undefined,
  deps: RunProcessCleanupDeps,
  scope: { detachedWorkers: boolean }
): RunProcessCleanupResult => {
  const result: RunProcessCleanupResult = { killed: [], skipped: [] };
  if (scope.detachedWorkers) {
    signalRunBridgeWorker(result, runDir, deps);
    signalRunUtilityWorkers(result, runDir, deps);
  }
  for (const { path, record } of readBridgeRegistrations(runDir)) {
    const command = deps.commandForPid(record.pid);
    const retainRegistration = signalOwnedProcess(
      result,
      record.pid,
      Boolean(
        command &&
          commandEndsWithArgs(command, [
            BRIDGE_SUBCOMMAND,
            record.runDir,
            record.source,
          ])
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

/**
 * The teardown's cleanup: the run's own governess is ending it, so its
 * detached bridge and utility workers are ended too (each under its identity
 * check).
 */
export const cleanupRunOwnedProcesses = (
  runDir: string,
  manifest: RunManifest | undefined
): RunProcessCleanupResult =>
  cleanupRunOwnedProcessesWithDeps(runDir, manifest, cleanupDeps, {
    detachedWorkers: true,
  });

const runIsProvablyAbandoned = (
  manifest: RunManifest,
  manifestPath: string,
  liveTmuxSessions: ReadonlySet<string> | undefined,
  deps: RunProcessCleanupDeps
): boolean => {
  if (isActiveRunState(manifest.state) && !manifest.tmuxSession) {
    const hasPaneIdentity = Boolean(
      manifest.tmuxPaneLeft ||
        manifest.tmuxPaneRight ||
        manifest.tmuxPaneGoverness ||
        manifest.tmuxPaneAuPair ||
        manifest.tmuxPaneNanny ||
        manifest.tmuxPaneRecon?.length
    );
    // A partially created session whose identity was lost is ambiguous and
    // remains owned. A never-bound launch has no pane identity; both recorded
    // launch processes being dead is then positive abandonment evidence.
    return !(
      hasPaneIdentity ||
      deps.pidAlive(manifest.pid) ||
      (manifest.launchAttemptPid && deps.pidAlive(manifest.launchAttemptPid))
    );
  }
  if (
    manifest.tmuxSession &&
    (!liveTmuxSessions || liveTmuxSessions.has(manifest.tmuxSession))
  ) {
    return false;
  }
  if (deps.pidAlive(manifest.pid)) {
    return false;
  }
  // The current server's session list says nothing about a run whose session
  // lives on another socket. Before GC marks such a run failed (which ends
  // every helper it routes next) or records a handback, the run's own server
  // must positively lack the session too: the recorded socket, or every
  // legacy candidate when it recorded none.
  return !manifest.tmuxSession || deps.runtimeAbsent(manifestPath);
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
      runIsProvablyAbandoned(
        input.manifest,
        input.manifestPath,
        input.liveTmuxSessions,
        input.deps
      )
    )
  ) {
    return undefined;
  }
  if (needsStateRepair) {
    input.deps.updateManifest(input.manifestPath, (current) =>
      current ? setRunManifestState(current, "failed") : undefined
    );
  }
  // GC judges abandonment from the CURRENT tmux server's session list alone,
  // which says nothing about a run whose session lived on another socket. It
  // therefore never signals the detached bridge or utility workers: those
  // stay recorded processes that keep the workspace owned until they are
  // gone, and only the run's own teardown ends them.
  const cleanup = hasProcessEvidence
    ? cleanupRunOwnedProcessesWithDeps(
        input.runDir,
        input.manifest,
        input.deps,
        { detachedWorkers: false }
      )
    : { killed: [], skipped: [] };
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
    const cleanupMayRelease = !cleanup.skipped.some((entry) =>
      entry.reason.startsWith("signal-failed:")
    );
    if (!(cleanupMayRelease && !withoutSettledOwnership.workspaceReleasedAt)) {
      return withoutSettledOwnership;
    }
    const releasedAt = input.deps.now();
    return {
      ...withoutSettledOwnership,
      updatedAt: releasedAt,
      workspaceReleasedAt: releasedAt,
      ...(withoutSettledOwnership.tmuxSession
        ? {}
        : { workspaceReleaseKind: "abandoned-never-bound" as const }),
    };
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

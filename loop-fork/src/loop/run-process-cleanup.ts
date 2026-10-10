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
import { defaultPidOwnershipDeps, pidCanStillOwnRun } from "./pid-ownership";
import {
  groupCanStillOwnRun,
  type ProcessRow,
  processGroupAlive,
  processGroupOf,
  readProcessTable,
  type TerminationTarget,
} from "./process-group";
import {
  agentPaneIdsOf,
  groupProvenAt,
  type ListedPane,
  PANE_LISTING_FORMAT,
  parsePaneListing,
  readAgentGroupRecords,
  readRunPaneProcessRecords,
  recordAgentDescendantGroups,
  recordRunPaneProcesses,
} from "./run-pane-processes";
import {
  auxiliaryProcessOwnership,
  buildManifestPath,
  isActiveRunState,
  type RunManifest,
  readRunManifest,
  readRunManifestHandle,
  resolveRepoId,
  resolveStorageRoot,
  setRunManifestState,
  updateRunManifest,
} from "./run-state";
import {
  classifyGroup,
  defaultOwnershipProbes,
  membersOf,
  type OwnershipContext,
  type OwnershipProbes,
  ownershipContext,
  recordedProcessClassifier,
  type SharedWith,
  selfOf,
  sharedWithOtherRun,
} from "./shared-process-ownership";
import { boundedTmuxOptions, tmuxCommandTimedOut } from "./tmux-control";
import { targetArgv, targetFromManifest } from "./tmux-socket";
import {
  commandEndsWithArgs,
  isUtilityWorkerCommand,
} from "./utility-constants";
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
  /**
   * Process groups (or, for a worker that leads none, single processes)
   * whose identity this cleanup verified, for the teardown to end after the
   * session kill: SIGTERM, a bounded grace, then SIGKILL. Present only when
   * non-empty.
   */
  groups?: TerminationTarget[];
  killed: number[];
  /**
   * Not signalled, and why. `shared-process-skipped` names the other run
   * that records or names the process (`otherRunId`); `detail` says which
   * record or rule applied.
   */
  skipped: Array<{
    detail?: string;
    otherRunId?: string;
    pid: number;
    reason: string;
  }>;
}

interface RunProcessCleanupDeps extends OwnershipProbes {
  commandForPid: (pid: number) => string | undefined;
  listeningPids: (port: number) => number[];
  /**
   * The panes of the run's tmux session on the run's own recorded socket, or
   * `undefined` when they cannot be listed (no recorded socket, no session,
   * or tmux failed). Never the ambient server.
   */
  listRunPanes: (runDir: string) => ListedPane[] | undefined;
  listTmuxSessions: () => ReadonlySet<string> | undefined;
  now: () => string;
  /** This process's own group, never signalled. `undefined` if unknown. */
  ownProcessGroup: () => number | undefined;
  pgidOf: (pid: number) => number | undefined;
  pidAlive: (pid: number) => boolean;
  pidStartedAt: (pid: number) => number | undefined;
  processGroupAlive: (pgid: number) => boolean;
  /** One snapshot of the whole process table, or `undefined`. */
  processTable: () => readonly ProcessRow[] | undefined;
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

/**
 * Keeps the panes of exactly `session` from `#{pane_id} #{pane_pid}
 * #{session_name}` lines. The session name is the rest of the line after the
 * two space-free fields and is compared whole, so one session's name being a
 * prefix of another's (`loop-9` and `loop-9 x`) selects only its own panes.
 */
export const panesOfSession = (stdout: string, session: string): ListedPane[] =>
  parsePaneListing(
    stdout
      .split("\n")
      .flatMap((line) => {
        const first = line.indexOf(" ");
        const second = first < 0 ? -1 : line.indexOf(" ", first + 1);
        return second > 0 && line.slice(second + 1) === session
          ? [line.slice(0, second)]
          : [];
      })
      .join("\n")
  );

/**
 * Lists the run's panes through its recorded socket only (`targetArgv`), so
 * neither a legacy socket-less run nor a test ever reaches the ambient tmux
 * server. `-a` lists every pane of that server; the exact session filter
 * keeps the run's own.
 */
const defaultListRunPanes = (runDir: string): ListedPane[] | undefined => {
  const manifestPath = buildManifestPath(runDir);
  const handle = readRunManifestHandle(manifestPath);
  const session = readRunManifest(manifestPath)?.tmuxSession;
  const target = handle ? targetFromManifest(handle) : undefined;
  if (!(target && session)) {
    return undefined;
  }
  try {
    const result = spawnSync(
      targetArgv(target, "list-panes", [
        "-a",
        "-F",
        `${PANE_LISTING_FORMAT} #{session_name}`,
      ]),
      boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" })
    );
    if (result.exitCode !== 0 || tmuxCommandTimedOut(result)) {
      return undefined;
    }
    return panesOfSession(decode(result.stdout), session);
  } catch {
    return undefined;
  }
};

const cleanupDeps: RunProcessCleanupDeps = {
  commandForPid: defaultCommandForPid,
  commandTable: defaultOwnershipProbes.commandTable,
  cwdOfPid: defaultOwnershipProbes.cwdOfPid,
  otherRunIndex: defaultOwnershipProbes.otherRunIndex,
  listRunPanes: defaultListRunPanes,
  listTmuxSessions: defaultListTmuxSessions,
  listeningPids: defaultListeningPids,
  now: () => new Date().toISOString(),
  ownProcessGroup: () => processGroupOf(process.pid),
  pgidOf: processGroupOf,
  pidAlive: defaultPidAlive,
  pidStartedAt: defaultPidOwnershipDeps.pidStartedAt,
  processGroupAlive,
  processTable: readProcessTable,
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
    // The worker is gone. Members of its group (bounded commands it ran) may
    // remain, but with the leader gone nothing proves whose group that is, so
    // it is never signalled here; the release evidence still counts it live.
    if (deps.processGroupAlive(pid)) {
      result.skipped.push({ pid, reason: "utility-worker-group-orphaned" });
    }
    return;
  }
  const command = deps.commandForPid(pid);
  if (!isUtilityWorkerCommand(command, { epoch: claim.epoch, jobId, runDir })) {
    result.skipped.push({
      pid,
      reason: command
        ? "utility-worker-command-mismatch"
        : "utility-worker-not-running",
    });
    return;
  }
  const source = `utility job ${jobId} worker`;
  // The worker was identified just now, so it (and every member of its
  // group) had started by this instant. The teardown's later signal rounds
  // re-identify the target against it, and against the worker command while
  // the leader lives: a pid or group id reused after this check, or a leader
  // that no longer runs this worker command, is never signalled.
  const identified = {
    identity: { epoch: claim.epoch, jobId, runDir },
    reference: deps.now(),
    source,
  };
  try {
    deps.signal(-pid, "SIGTERM");
    result.killed.push(pid);
    pushGroup(result, { id: pid, kind: "group", ...identified });
    return;
  } catch {
    // Not a process-group leader: signal the worker alone below.
  }
  signalOwnedProcess(result, pid, true, "", deps.signal);
  pushGroup(result, { id: pid, kind: "process", ...identified });
};

const pushGroup = (
  result: RunProcessCleanupResult,
  target: TerminationTarget
): void => {
  result.groups = [...(result.groups ?? []), target];
};

/**
 * The run's agent process groups, collected right before the session kill
 * while the agent CLIs are still the parents of their tool subprocesses:
 *
 * - each agent pane listed in the run's own session on its recorded socket is
 *   recorded (so a pane respawned since the launch is tracked too);
 * - one process table snapshot is taken, and the groups of every descendant
 *   of each recorded pane process are recorded (`recordAgentDescendantGroups`:
 *   the real CLIs start their tool subprocesses in groups of their own);
 * - every recorded agent group (pane or descendant) that is provably the
 *   recorded group in that snapshot (a member started by the record's
 *   instant) becomes a termination target, with the snapshot instant as its
 *   reference: right before each signal the target is re-identified (some
 *   live member started by that instant), so a group id reused after the
 *   snapshot is never signalled. A present group that cannot be proven is
 *   reported `agent-group-unverified` and stays release evidence.
 *
 * Nothing is signalled here; the teardown ends the targets after the kill
 * (the hangup reaches the CLI, not a tool subprocess that ignores it). This
 * process's own group is never a target. Without a table nothing is targeted
 * and the release evidence keeps judging every record.
 */
const collectRunAgentGroupsWithDeps = (
  runDir: string,
  manifest: RunManifest | undefined,
  deps: RunProcessCleanupDeps
): RunProcessCleanupResult => {
  const result: RunProcessCleanupResult = { killed: [], skipped: [] };
  const listed = manifest?.tmuxSession ? deps.listRunPanes(runDir) : undefined;
  if (manifest?.tmuxSession && listed) {
    recordRunPaneProcesses({
      agentPaneIds: agentPaneIdsOf(manifest),
      now: deps.now,
      panes: listed,
      pgidOf: deps.pgidOf,
      runDir,
      session: manifest.tmuxSession,
    });
  }
  const table = deps.processTable();
  const snapshotAt = deps.now();
  if (!table) {
    result.skipped.push({ pid: 0, reason: "process-table-unavailable" });
    return result;
  }
  const own = deps.ownProcessGroup();
  recordAgentDescendantGroups({
    groupAlive: deps.processGroupAlive,
    now: () => snapshotAt,
    ownGroup: own,
    runDir,
    table,
  });
  const present = new Set(table.map((row) => row.pgid));
  const paneGroups = new Set(
    readRunPaneProcessRecords(runDir).map((record) => record.pgid)
  );
  const recorded = [
    ...readRunPaneProcessRecords(runDir).map((record) => ({
      pgid: record.pgid,
      recordedAt: record.recordedAt,
      source: `agent pane ${record.paneId}`,
    })),
    ...readAgentGroupRecords(runDir).map((record) => ({
      pgid: record.pgid,
      recordedAt: record.recordedAt,
      source: `agent ${record.paneId} descendant`,
    })),
  ].filter((record) => present.has(record.pgid));
  // Whose group is it (see `shared-process-ownership`): one another live run
  // records or names is never targeted, nor one whose ownership cannot be
  // judged, nor a daemon that re-parented away and works outside the
  // workspace.
  const ownership = ownershipContext({ manifest, probes: deps, runDir, table });
  // A group present in the snapshot is targeted only when some record of it
  // proves it is still the recorded group (a member started by the record's
  // instant); otherwise its id may now name an unrelated, later group.
  const proven = new Map<number, string>();
  for (const record of recorded) {
    if (
      !proven.has(record.pgid) &&
      groupProvenAt(record.pgid, record.recordedAt, table)
    ) {
      proven.set(record.pgid, record.source);
    }
  }
  const seen = new Set<number>();
  for (const { pgid, source } of recorded) {
    if (seen.has(pgid)) {
      continue;
    }
    seen.add(pgid);
    if (pgid === own) {
      result.skipped.push({ pid: pgid, reason: "own-process-group" });
      continue;
    }
    const provenSource = proven.get(pgid);
    if (provenSource === undefined) {
      result.skipped.push({
        pid: pgid,
        reason: `agent-group-unverified: ${source}`,
      });
      continue;
    }
    // A pane group is the run's own pane; a descendant group is the run's
    // only by the walk.
    targetUnlessShared(result, ownership, {
      inferred: !paneGroups.has(pgid),
      pgid,
      reference: snapshotAt,
      source: provenSource,
    });
  }
  return result;
};

/**
 * Targets one proven agent group, unless its ownership rule forbids a signal
 * (`shared-process-skipped`, `ownership-unknown`,
 * `reparented-outside-workspace`): then it is reported skipped with the rule,
 * the other run's id when there is one, and what applied.
 */
const targetUnlessShared = (
  result: RunProcessCleanupResult,
  ownership: OwnershipContext,
  group: { inferred: boolean; pgid: number; reference: string; source: string }
): void => {
  const verdict = classifyGroup(group.pgid, ownership, {
    inferred: group.inferred,
  });
  if (!verdict.kill) {
    result.skipped.push({
      detail: `${group.source}: ${verdict.detail ?? verdict.rule}`,
      ...(verdict.otherRunId ? { otherRunId: verdict.otherRunId } : {}),
      pid: group.pgid,
      reason: verdict.rule,
    });
    return;
  }
  pushGroup(result, {
    id: group.pgid,
    kind: "group",
    ...(group.inferred ? { ownership: "inferred" as const } : {}),
    reference: group.reference,
    ...(verdict.rule === "run-owned" ? {} : { rule: verdict.rule }),
    source: group.source,
  });
};

/**
 * Records the groups of the run's agent CLIs' descendants from one fresh
 * process table snapshot (see `recordAgentDescendantGroups`), and prunes the
 * records of gone groups. Returns `false` when no table could be read.
 */
export const recordRunAgentDescendants = (
  runDir: string,
  deps: RunProcessCleanupDeps = cleanupDeps
): boolean => {
  const table = deps.processTable();
  if (!table) {
    return false;
  }
  const at = deps.now();
  recordAgentDescendantGroups({
    groupAlive: deps.processGroupAlive,
    now: () => at,
    ownGroup: deps.ownProcessGroup(),
    runDir,
    table,
  });
  return true;
};

/** How often the governess's cycle snapshots the agent descendants. */
export const AGENT_DESCENDANT_SNAPSHOT_INTERVAL_MS = 5000;
const lastDescendantSnapshotMs = new Map<string, number>();

/** `recordRunAgentDescendants` at most once per interval per run. */
export const recordRunAgentDescendantsThrottled = (
  runDir: string,
  nowMs: number = Date.now()
): void => {
  const last = lastDescendantSnapshotMs.get(runDir);
  if (
    last !== undefined &&
    nowMs >= last &&
    nowMs - last < AGENT_DESCENDANT_SNAPSHOT_INTERVAL_MS
  ) {
    return;
  }
  lastDescendantSnapshotMs.set(runDir, nowMs);
  recordRunAgentDescendants(runDir);
};

/**
 * The teardown's pre-kill collection of the run's agent process groups (see
 * `collectRunAgentGroupsWithDeps`). Called as late as possible, right before
 * the session kill, so a tool subprocess started during the beat close is
 * seen too.
 */
export const collectRunAgentGroups = (
  runDir: string,
  manifest: RunManifest | undefined
): RunProcessCleanupResult => {
  try {
    return collectRunAgentGroupsWithDeps(runDir, manifest, cleanupDeps);
  } catch (error) {
    // Never kill authority; the release evidence still reads the records.
    return {
      killed: [],
      skipped: [
        {
          pid: 0,
          reason: `agent-groups-unreadable: ${(error as Error).message}`,
        },
      ],
    };
  }
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
  if (manifest && appServerPid) {
    signalRunAppServer(result, runDir, manifest, appServerPid, deps);
  }
  return result;
};

const WHITESPACE_SPLIT_RE = /\s+/;

/**
 * Whether `command` is a Codex app-server listening on exactly `url`: an
 * `app-server` argument and `--listen <url>` (or `--listen=<url>`) as whole
 * arguments, as `codex-app-server.ts` launches it.
 */
export const commandListensOn = (command: string, url: string): boolean => {
  const words = command.split(WHITESPACE_SPLIT_RE);
  return (
    words.includes("app-server") &&
    words.some(
      (word, index) =>
        word === `--listen=${url}` ||
        (word === "--listen" && words[index + 1] === url)
    )
  );
};

/**
 * Why the live process `pid` is not provably this run's Codex app-server, or
 * `undefined` when it is. The identity is bound positively, never by the
 * absence of other runs' records: the manifest records the exact listen URL
 * (`codexRemoteUrl`; a run recorded before it has none, and is unproven); the
 * live command line is `app-server --listen <that URL>`; the process holds
 * that port's listener; and it started no later than the manifest's last
 * update (the record), on one process table snapshot. Ports and pids are
 * reused, but a process created after the record is not the recorded one,
 * and one that is not listening on the recorded URL is not this run's
 * app-server.
 */
const appServerIdentityGap = (
  manifest: RunManifest,
  pid: number,
  command: string,
  table: readonly ProcessRow[] | undefined,
  deps: RunProcessCleanupDeps
): string | undefined => {
  const url = manifest.codexRemoteUrl;
  if (!url) {
    return "the manifest records no codexRemoteUrl";
  }
  if (!commandListensOn(command, url)) {
    return `its command does not listen on ${url}`;
  }
  const port = appServerPort(url);
  if (!(port && deps.listeningPids(port).includes(pid))) {
    return `it does not hold the listener of ${url}`;
  }
  if (!table) {
    return "process table unavailable";
  }
  const row = table.find((entry) => entry.pid === pid);
  const recordedMs = Date.parse(manifest.updatedAt);
  if (!row || row.startedAtMs === undefined) {
    return "its start time is unknown";
  }
  if (!(Number.isFinite(recordedMs) && row.startedAtMs <= recordedMs)) {
    return `it started after the record (${manifest.updatedAt})`;
  }
  return undefined;
};

/**
 * Ends the run's own Codex app-server only when its identity is bound
 * positively (`appServerIdentityGap`) and no readable live run records it (in
 * a record other than its ppid walk) or names it on its command line. Whether
 * the other runs can all be read does not matter for a bound app-server: an
 * unreadable run could hold only a walk record of it (ignored for an explicit
 * record) or a recycled pid (rejected by the binding). An unbound one is
 * never signalled, whatever the other runs say; the skip is logged with why,
 * and with the unreadable state when there is one. An app-server that is not
 * running is skipped before the other runs are read: either way nothing is
 * signalled, and the index read costs seconds on a large storage root.
 *
 * The app-server is spawned detached, so it leads a process group of its own,
 * and Codex starts some children in it (the plugin `git fetch` on start).
 * When the snapshot shows the bound app-server leading its group, and that is
 * not this process's own group, the whole group is signalled, so those
 * children end with it instead of re-parenting to launchd. The sharing check
 * above already judged every member of that group (`membersOf` "process"
 * covers the pid and its group). Children Codex moves into groups of their
 * own (MCP servers) are not reached this way; they exit with the app-server.
 */
const signalRunAppServer = (
  result: RunProcessCleanupResult,
  runDir: string,
  manifest: RunManifest,
  pid: number,
  deps: RunProcessCleanupDeps
): void => {
  const command = deps.commandForPid(pid);
  if (!command) {
    result.skipped.push({ pid, reason: "app-server-not-running" });
    return;
  }
  const table = deps.processTable();
  const shared = appServerSharedWith(runDir, manifest, pid, table, deps);
  if (shared.kind === "shared") {
    result.skipped.push({
      detail: `codexAppServerPid: ${shared.source}`,
      otherRunId: shared.otherRunId,
      pid,
      reason: "shared-process-skipped",
    });
    return;
  }
  const gap = appServerIdentityGap(manifest, pid, command, table, deps);
  if (gap) {
    result.skipped.push({
      detail: `identity not proven: ${gap}${shared.kind === "unknown" ? `; other runs unreadable: ${shared.reason}` : ""}`,
      pid,
      reason: "app-server-identity-mismatch",
    });
    return;
  }
  const ownGroup = deps.ownProcessGroup();
  const leadsGroup =
    ownGroup !== undefined &&
    ownGroup !== pid &&
    table?.find((entry) => entry.pid === pid)?.pgid === pid;
  signalOwnedProcess(result, pid, true, "", (target, signal) =>
    deps.signal(leadsGroup ? -target : target, signal)
  );
};

/**
 * Whether a live run records the run's Codex app-server (its pid or group) in
 * a record other than its ppid walk, or its command line names that run's
 * directory, socket, session or run id. The app-server is the run's own
 * explicit record: another run's walk only saw it descend from that run's
 * panes (this run was launched from one of them), and must not stop its
 * owner's teardown from ending it. With some runs unreadable, the readable
 * ones are still consulted (`sharedWithOtherRun`). Without a process table
 * the recorded pid itself is compared (as a process of unknown start, which
 * errs toward shared).
 */
const appServerSharedWith = (
  runDir: string,
  manifest: RunManifest | undefined,
  pid: number,
  table: readonly ProcessRow[] | undefined,
  deps: RunProcessCleanupDeps
): SharedWith => {
  const members = table
    ? membersOf(pid, "process", table)
    : [{ pgid: pid, pid, ppid: 0, startedAtMs: undefined }];
  let index: ReturnType<OwnershipProbes["otherRunIndex"]> | undefined;
  return sharedWithOtherRun({
    commands: deps.commandTable,
    ignoreWalkRecords: true,
    index: () => {
      index ??= deps.otherRunIndex(runDir, table);
      return index;
    },
    members,
    pgid: pid,
    self: selfOf(manifest),
  });
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

interface GcOwnership {
  group: (pgid: number, at?: string) => boolean;
  pid: (pid: number, at?: string) => boolean;
  reference: string;
}

/**
 * The release rules (PID reuse, group membership) on GC's own probes, with
 * the manifest's last update as the default PID-reuse reference.
 */
const gcOwnership = (
  deps: RunProcessCleanupDeps,
  reference: string
): GcOwnership => {
  const probe = {
    isPidAlive: deps.pidAlive,
    pidStartedAt: deps.pidStartedAt,
    processGroupAlive: deps.processGroupAlive,
  };
  return {
    group: (pgid, at = reference) => groupCanStillOwnRun(pgid, at, probe),
    pid: (pid, at = reference) => pidCanStillOwnRun(pid, at, probe),
    reference,
  };
};

/** Why GC may not write the handback, or `undefined` when it may. */
const gcReleaseBlocker = (
  manifestPath: string,
  manifest: RunManifest,
  ownership: GcOwnership,
  probes: OwnershipProbes
): string | undefined => {
  if (ownership.pid(manifest.pid)) {
    return "run-process-may-be-live";
  }
  if (
    manifest.launchAttemptPid !== undefined &&
    ownership.pid(manifest.launchAttemptPid)
  ) {
    return "launch-process-may-be-live";
  }
  return auxiliaryProcessOwnership(
    manifestPath,
    manifest,
    ownership.reference,
    (pid, at) => ownership.pid(pid, at),
    (pgid, at) => ownership.group(pgid, at),
    recordedProcessClassifier(probes)
  );
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
  // A launch that never bound tmux is released by nothing but this GC (no
  // `loop reconcile` can prove a session-less run gone), so its repair and its
  // handback are one write: if a recorded process blocks the handback, the
  // run stays active and the next GC judges it again. A tmux-bound run is
  // repaired at once; once failed, the launch auto-release judges it.
  const neverBound = !input.manifest.tmuxSession;
  if (needsStateRepair && !neverBound) {
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
    const ownership = gcOwnership(input.deps, current.updatedAt);
    // An app-server this pass signalled is settled only once it is gone; one
    // still exiting stays recorded, so it keeps the workspace owned and the
    // next pass re-checks it.
    const appServerPid = current.codexAppServerPid;
    const withoutSettledOwnership =
      retainAppServerOwnership ||
      (appServerPid !== undefined && ownership.pid(appServerPid))
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
    // The handback is written on the same full evidence as `loop reconcile`
    // and the launch auto-release: no recorded process of the run (its pid,
    // launch attempt, app-server, bridge worker, run-processes entries and
    // agent pane groups, and every utility worker's process group) may still
    // be live. Short of that the run is only repaired, not released.
    if (
      gcReleaseBlocker(
        input.manifestPath,
        withoutSettledOwnership,
        ownership,
        input.deps
      )
    ) {
      return withoutSettledOwnership;
    }
    const releasedAt = input.deps.now();
    const repaired =
      neverBound && isActiveRunState(withoutSettledOwnership.state)
        ? setRunManifestState(withoutSettledOwnership, "failed", releasedAt)
        : withoutSettledOwnership;
    return {
      ...repaired,
      updatedAt: releasedAt,
      workspaceReleasedAt: releasedAt,
      ...(repaired.tmuxSession
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
  /** The production pane listing, for a test against a private server. */
  listRunPanes: defaultListRunPanes,
};

import { createInterface } from "node:readline/promises";
import { spawnSync } from "bun";
import {
  type A2ALeaseReleaseOutcome,
  describeA2ALeaseRelease,
  releaseRecordedA2ALease,
} from "./a2a-session-client";
import { STOP_USAGE } from "./constants";
import {
  confirmTeardownRelease,
  type TeardownReleaseResult,
} from "./governess";
import { closeGovernessBeatForTerminalRun } from "./governess-beat-close";
import { tmuxRuntimeAbsentForManifest } from "./launch-reservation";
import { defaultPidOwnershipDeps, pidCanStillOwnRun } from "./pid-ownership";
import {
  defaultTerminationDeps,
  groupCanStillOwnRun,
  type TerminationTarget,
  terminateTargets,
} from "./process-group";
import {
  cleanupRunOwnedProcesses,
  collectRunAgentGroups,
  type RunProcessCleanupResult,
} from "./run-process-cleanup";
import {
  appendRunTranscriptEntry,
  createRunStatusEntry,
  isActiveRunState,
  type RunManifest,
  type RunStorage,
  readRunManifest,
  readRunManifestHandle,
  resolveRunStorage,
  setRunManifestState,
  updateRunManifest,
} from "./run-state";
import {
  defaultOwnershipProbes,
  recordedProcessClassifier,
  sharedTargetCheck,
} from "./shared-process-ownership";
import {
  boundedTmuxOptions,
  isConfirmedMissingTmuxSession,
  tmuxCommandTimedOut,
} from "./tmux-control";
import { serverArgv, targetArgv, targetFromManifest } from "./tmux-socket";

export const STOP_COMMAND = "stop";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const YES_ANSWER_RE = /^y(?:es)?$/iu;
const YES_FLAGS = new Set(["--yes", "-y"]);
const STOP_RELEASE_ATTEMPTS = 10;
const STOP_RELEASE_RETRY_MS = 300;

export interface RunStopArgs {
  runId: string;
  yes: boolean;
}

/** `<run-id> [--yes]`, in either order; anything else is a usage error. */
export const parseStopArgs = (argv: readonly string[]): RunStopArgs => {
  const yes = argv.some((arg) => YES_FLAGS.has(arg));
  const rest = argv.filter((arg) => !YES_FLAGS.has(arg));
  const [runId, ...extra] = rest;
  if (!runId || extra.length > 0 || !RUN_ID_RE.test(runId)) {
    throw new Error(`Usage: ${STOP_USAGE}`);
  }
  return { runId, yes };
};

/**
 * What the session kill established. `absent` is positive: the run's
 * recorded server answered and holds no session of exactly that name.
 */
export type SessionKillOutcome =
  | { kind: "absent" }
  | { kind: "failed"; detail: string }
  | { kind: "killed" }
  | { kind: "unaddressable"; detail: string };

export interface RunStopDeps {
  /**
   * Ends the run's own detached processes (app-server, bridge worker, bridge
   * MCP registrations, utility workers) on their identity binding, and
   * returns the verified groups to end after the kill.
   */
  cleanupRunProcesses: (
    runDir: string,
    manifest: RunManifest
  ) => RunProcessCleanupResult;
  closeBeat: (input: { manifestPath: string; runId: string }) => Promise<void>;
  /** Right before the kill: the run's verified agent process groups. */
  collectAgentGroups: (
    runDir: string,
    manifest: RunManifest
  ) => RunProcessCleanupResult;
  /** Asks the human; absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
  killSession: (manifestPath: string, session: string) => SessionKillOutcome;
  log: (line: string) => void;
  now: () => string;
  release: (
    manifestPath: string,
    runId: string,
    terminalState: "failed" | "stopped"
  ) => Promise<TeardownReleaseResult>;
  /** Releases the A2A lease recorded in the run dir. Never throws. */
  releaseA2ALease?: (runDir: string) => Promise<A2ALeaseReleaseOutcome>;
  resolveStorage: (runId: string) => RunStorage;
  terminateGroups: (
    runDir: string,
    manifestPath: string,
    groups: readonly TerminationTarget[]
  ) => Promise<unknown>;
}

export interface RunStopReport {
  /** Present when the run held an A2A lease record. */
  a2aRelease?: A2ALeaseReleaseOutcome;
  ended: number[];
  /** Verified process groups ended after the kill. */
  groups: number;
  previousState: string;
  releaseDetail: string;
  released: boolean;
  runId: string;
  session?: string;
  sessionKill: SessionKillOutcome["kind"];
  skipped: RunProcessCleanupResult["skipped"];
  state: string;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safely = (
  step: string,
  run: () => RunProcessCleanupResult,
  log: (line: string) => void
): RunProcessCleanupResult => {
  try {
    return run();
  } catch (error) {
    // Never kill authority; the release evidence still reads every record.
    log(`[loop] stop: ${step} failed: ${describe(error)}`);
    return { killed: [], skipped: [{ pid: 0, reason: `${step}-failed` }] };
  }
};

/**
 * Marks an active run stopped (a terminal run keeps its state) and records
 * why in its transcript, as the Governess teardown does. Returns the run as
 * it now is.
 */
const markStopped = (
  storage: RunStorage,
  deps: RunStopDeps
): RunManifest | undefined => {
  let stopped = false;
  const updated = updateRunManifest(storage.manifestPath, (current) => {
    if (!(current && isActiveRunState(current.state))) {
      return undefined;
    }
    stopped = true;
    return setRunManifestState(current, "stopped", deps.now());
  });
  if (stopped) {
    appendRunTranscriptEntry(
      storage.transcriptPath,
      createRunStatusEntry("stopped", "loop stop", deps.now())
    );
  }
  return updated ?? readRunManifest(storage.manifestPath);
};

/**
 * The run no longer serves a supervisor: hand back an A2A endpoint it holds.
 * Never throws and never decides the stop; a failed release lapses by the
 * lease TTL. Recorded in the report only when the run held a lease.
 */
const releaseStoppedRunA2ALease = async (
  runDir: string,
  deps: RunStopDeps,
  report: RunStopReport
): Promise<void> => {
  if (!deps.releaseA2ALease) {
    return;
  }
  try {
    const a2a = await deps.releaseA2ALease(runDir);
    if (a2a.outcome === "none") {
      return;
    }
    report.a2aRelease = a2a;
    const line = describeA2ALeaseRelease(a2a);
    if (line) {
      deps.log(line);
    }
  } catch (error) {
    deps.log(`[loop] stop: A2A endpoint release failed: ${describe(error)}`);
  }
};

const releaseState = (state: string): "failed" | "stopped" | undefined => {
  if (state === "failed" || state === "stopped") {
    return state;
  }
  return undefined;
};

/**
 * `loop stop <run-id> [--yes]`: tears a run down the way the Governess
 * teardown does, for a run no Governess will tear down (a failed start
 * preserved for recovery, or one whose Governess is gone). In order:
 *
 * 1. mark it stopped (a failed or completed run keeps its state);
 * 2. end its own detached processes on their identity binding (its Codex
 *    app-server, bridge worker, bridge MCP registrations, utility workers),
 *    never one another live run records or names;
 * 3. collect its verified agent process groups while the agent CLIs still
 *    parent their tool subprocesses;
 * 4. kill exactly its tmux session on its recorded socket;
 * 5. end the verified groups (SIGTERM, grace, SIGKILL; shared ones skipped);
 * 6. hand the workspace back on `loop reconcile`'s full evidence.
 *
 * An unconfirmed kill ends no group and releases nothing. Returns the report,
 * or `undefined` when the human declined.
 */
export const stopRun = async (
  argv: readonly string[],
  deps: RunStopDeps
): Promise<RunStopReport | undefined> => {
  const { runId, yes } = parseStopArgs(argv);
  const storage = deps.resolveStorage(runId);
  const manifest = readRunManifest(storage.manifestPath);
  if (!manifest || manifest.runId !== runId) {
    throw new Error(
      `[loop] run ${runId} does not exist in this repository (${storage.manifestPath})`
    );
  }
  const session = manifest.tmuxSession;
  if (!yes) {
    if (!deps.confirm) {
      throw new Error(
        `[loop] refusing to stop run ${runId} (${session ?? "no tmux session"}, ${manifest.state}) without confirmation: pass --yes to stop it without a prompt`
      );
    }
    const accepted = await deps.confirm(
      `Stop run ${runId} (${session ?? "no tmux session"}, ${manifest.state}) in ${manifest.workspaceBinding?.root ?? manifest.cwd}? This kills its tmux session and ends its own processes. [y/N] `
    );
    if (!accepted) {
      deps.log(`[loop] run ${runId} was not stopped.`);
      return undefined;
    }
  }
  const current = markStopped(storage, deps) ?? manifest;
  const cleanup = safely(
    "run-process-cleanup",
    () => deps.cleanupRunProcesses(storage.runDir, current),
    deps.log
  );
  const collected = safely(
    "agent-group-collection",
    () => deps.collectAgentGroups(storage.runDir, current),
    deps.log
  );
  const kill: SessionKillOutcome = session
    ? deps.killSession(storage.manifestPath, session)
    : { detail: "the run recorded no tmux session", kind: "unaddressable" };
  const groups = [...(cleanup.groups ?? []), ...(collected.groups ?? [])];
  const report: RunStopReport = {
    ended: cleanup.killed,
    groups: 0,
    previousState: manifest.state,
    released: false,
    releaseDetail: "",
    runId,
    ...(session ? { session } : {}),
    sessionKill: kill.kind,
    skipped: [...cleanup.skipped, ...collected.skipped],
    state: current.state,
  };
  if (kill.kind === "failed") {
    report.releaseDetail = `the session kill was not confirmed (${kill.detail}); no group was ended and nothing was released`;
    return report;
  }
  await releaseStoppedRunA2ALease(storage.runDir, deps, report);
  if (groups.length > 0) {
    await deps.terminateGroups(storage.runDir, storage.manifestPath, groups);
    report.groups = groups.length;
  }
  const terminalState = releaseState(current.state);
  if (!terminalState) {
    report.releaseDetail = `the run is ${current.state}; only a stopped or failed run is released`;
    return report;
  }
  const release = await deps.release(
    storage.manifestPath,
    runId,
    terminalState
  );
  report.released = release.released;
  report.releaseDetail = release.detail;
  report.state = readRunManifest(storage.manifestPath)?.state ?? current.state;
  try {
    await deps.closeBeat({ manifestPath: storage.manifestPath, runId });
  } catch (error) {
    deps.log(`[loop] stop: governess-beat close failed: ${describe(error)}`);
  }
  return report;
};

/**
 * Kills exactly `session` on the run's recorded socket. tmux resolves a
 * `-t` name it cannot find exactly by prefix (`loop-1` would match
 * `loop-10`), so the kill is issued only once the server lists a session of
 * exactly this name; otherwise it is positively absent and nothing is
 * signalled.
 */
const killRecordedSession = (
  manifestPath: string,
  session: string
): SessionKillOutcome => {
  const handle = readRunManifestHandle(manifestPath);
  const target = handle ? targetFromManifest(handle) : undefined;
  if (!target) {
    return {
      detail: "the run recorded no usable tmux socket and session",
      kind: "unaddressable",
    };
  }
  const decode = (value: unknown): string =>
    typeof value === "string"
      ? value
      : new TextDecoder().decode(value as Uint8Array | undefined);
  try {
    const listed = spawnSync(
      serverArgv(target, ["list-sessions", "-F", "#{session_name}"]),
      boundedTmuxOptions({ stderr: "pipe", stdout: "pipe" })
    );
    if (tmuxCommandTimedOut(listed)) {
      return { detail: "tmux list-sessions timed out", kind: "failed" };
    }
    if (listed.exitCode !== 0) {
      const stderr = decode(listed.stderr);
      return isConfirmedMissingTmuxSession(stderr, true)
        ? { kind: "absent" }
        : {
            detail: stderr.trim() || "tmux list-sessions failed",
            kind: "failed",
          };
    }
    if (!decode(listed.stdout).split("\n").includes(session)) {
      return { kind: "absent" };
    }
    const killed = spawnSync(
      targetArgv(target, "kill-session"),
      boundedTmuxOptions({ stderr: "pipe", stdout: "ignore" })
    );
    if (tmuxCommandTimedOut(killed)) {
      return { detail: "tmux kill-session timed out", kind: "failed" };
    }
    return killed.exitCode === 0
      ? { kind: "killed" }
      : {
          detail: decode(killed.stderr).trim() || "tmux kill-session failed",
          kind: "failed",
        };
  } catch (error) {
    return { detail: describe(error), kind: "failed" };
  }
};

const askOnTerminal = async (question: string): Promise<boolean> => {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question(question);
    return YES_ANSWER_RE.test(answer.trim());
  } finally {
    prompt.close();
  }
};

export const defaultRunStopDeps = (): RunStopDeps => ({
  cleanupRunProcesses: cleanupRunOwnedProcesses,
  closeBeat: async ({ manifestPath, runId }) => {
    const closed = await closeGovernessBeatForTerminalRun({
      env: process.env,
      manifestPath,
      reason: "loop stop",
      runId,
    });
    for (const one of closed?.legacy ? [closed, closed.legacy] : [closed]) {
      if (one) {
        process.stderr.write(
          `[loop] ${one.workflowId}: ${one.outcome}${one.detail ? ` (${one.detail})` : ""}\n`
        );
      }
    }
  },
  collectAgentGroups: collectRunAgentGroups,
  ...(process.stdin.isTTY ? { confirm: askOnTerminal } : {}),
  killSession: killRecordedSession,
  log: (line) => {
    process.stderr.write(`${line}\n`);
  },
  now: () => new Date().toISOString(),
  release: (manifestPath, runId, terminalState) =>
    confirmTeardownRelease(manifestPath, runId, {
      attempts: STOP_RELEASE_ATTEMPTS,
      classifyRecordedProcess: recordedProcessClassifier(
        defaultOwnershipProbes
      ),
      groupCanStillOwnRun: (pgid, at) =>
        groupCanStillOwnRun(pgid, at, defaultPidOwnershipDeps),
      now: () => new Date().toISOString(),
      pidCanStillOwnRun: (pid, at) =>
        pidCanStillOwnRun(pid, at, defaultPidOwnershipDeps),
      retryMs: STOP_RELEASE_RETRY_MS,
      runtimeAbsent: (path) => tmuxRuntimeAbsentForManifest(path),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      terminalState,
    }),
  releaseA2ALease: (runDir) => releaseRecordedA2ALease(runDir),
  resolveStorage: (runId) => resolveRunStorage(runId),
  terminateGroups: (runDir, manifestPath, groups) =>
    terminateTargets(groups, {
      ...defaultTerminationDeps(),
      // Right before every signal round, a target another live run now
      // records or names is skipped (`shared-process-skipped`).
      sharedSkips: sharedTargetCheck(runDir, () =>
        readRunManifest(manifestPath)
      ),
    }),
});

/**
 * The `loop stop` command. Prints the report as JSON; fails when the run
 * was stopped but its workspace could not be handed back, so a script knows
 * the next launch may still conflict.
 */
export const runStopCommand = async (
  argv: readonly string[],
  deps?: RunStopDeps,
  print: (text: string) => void = (text) => {
    process.stdout.write(text);
  }
): Promise<boolean> => {
  if (argv[0] !== STOP_COMMAND) {
    return false;
  }
  // Resolved only for `loop stop`: the defaults touch process.stdin.
  const report = await stopRun(argv.slice(1), deps ?? defaultRunStopDeps());
  if (!report) {
    return true;
  }
  print(`${JSON.stringify(report)}\n`);
  if (!report.released) {
    throw new Error(
      `run ${report.runId} was stopped, but its workspace was not released: ${report.releaseDetail}`
    );
  }
  return true;
};

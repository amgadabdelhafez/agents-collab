import { spawnSync } from "node:child_process";

/**
 * Process groups as release evidence and as the unit a teardown ends.
 *
 * A utility worker is spawned detached, so it leads its own process group
 * (pgid = its pid), and the bounded commands it runs (verify, test, build)
 * stay in that group with their cwd in the workspace. An agent pane's process
 * is a session and group leader too (tmux setsid()s it), and the agent CLI and
 * its tool subprocesses stay in that group unless they leave it. Either kind
 * of group can outlive its leader: a stale-recovery kill of the worker pid, or
 * a pane whose CLI died on the session hangup, leaves its members running. So
 * a recorded group is live while ANY member exists, not only while its leader
 * does.
 *
 * PID-reuse rule for a group: a pid is never allocated while a process group
 * with that id exists (POSIX; XNU and Linux both check it on fork). So when a
 * live process holds the group's id as its pid and provably started after the
 * reference instant, the recorded group was entirely gone when that process
 * was created, and every current member of a group with that id is unrelated.
 */

export interface GroupOwnershipProbe {
  isPidAlive: (pid: number) => boolean;
  pidStartedAt: (pid: number) => number | undefined;
  processGroupAlive: (pgid: number) => boolean;
}

/**
 * Only a group id above 1 is ever probed or signalled: `kill(0)` addresses the
 * caller's own group and `kill(-1)` every process the caller may signal.
 */
export const isSignallableGroup = (pgid: number): boolean =>
  Number.isSafeInteger(pgid) && pgid > 1;

/**
 * Whether any process is a member of group `pgid`. `ESRCH` is the only answer
 * that proves the group empty; `EPERM` (a member we may not signal) and any
 * other failure keep it live.
 */
export const processGroupAlive = (pgid: number): boolean => {
  if (!isSignallableGroup(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Whether the recorded group `pgid` may still hold a process of the run.
 * `reference` is a moment by which the group's leader had certainly started.
 * A live leader is judged by the PID-reuse rule alone (a provably later
 * process holding the id means the recorded group is gone). With the leader
 * gone, any member keeps the group live: a recycled group id can therefore
 * falsely block a release, never falsely grant one.
 */
export const groupCanStillOwnRun = (
  pgid: number,
  reference: string,
  probe: GroupOwnershipProbe
): boolean => {
  if (!isSignallableGroup(pgid)) {
    return false;
  }
  if (probe.isPidAlive(pgid)) {
    const startedAt = probe.pidStartedAt(pgid);
    const referenceMs = Date.parse(reference);
    return (
      startedAt === undefined ||
      !Number.isFinite(referenceMs) ||
      startedAt <= referenceMs
    );
  }
  return probe.processGroupAlive(pgid);
};

/** The process group of `pid` as `ps` reports it, or `undefined`. */
export const processGroupOf = (pid: number): number | undefined => {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return undefined;
  }
  const result = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const pgid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
};

/** One thing a teardown or stale recovery ends: a whole group, or one process. */
export interface TerminationTarget {
  readonly id: number;
  readonly kind: "group" | "process";
  readonly source: string;
}

export interface TerminationDeps {
  graceMs: number;
  isPidAlive: (pid: number) => boolean;
  killWaitMs: number;
  nowMs: () => number;
  pollMs: number;
  processGroupAlive: (pgid: number) => boolean;
  /** `process.kill`: a negative id signals the group. */
  signal: (id: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface TerminationResult {
  /** Gone within the SIGTERM grace (or already gone). */
  readonly exited: string[];
  /** A signal that failed with anything but ESRCH. */
  readonly failed: Array<{ reason: string; target: string }>;
  /** Still alive after the grace, so sent SIGKILL. */
  readonly killed: string[];
  /** Still alive after SIGKILL and its wait: the release must not proceed. */
  readonly survivors: string[];
}

const label = (target: TerminationTarget): string =>
  `${target.source} ${target.kind === "group" ? "process group" : "pid"} ${target.id}`;

const targetAlive = (
  target: TerminationTarget,
  deps: TerminationDeps
): boolean =>
  target.kind === "group"
    ? deps.processGroupAlive(target.id)
    : deps.isPidAlive(target.id);

const sendSignal = (
  target: TerminationTarget,
  signal: NodeJS.Signals,
  deps: TerminationDeps
): string | undefined => {
  try {
    deps.signal(target.kind === "group" ? -target.id : target.id, signal);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? undefined : `signal-failed:${code ?? "unknown"}`;
  }
};

const waitUntilGone = async (
  targets: readonly TerminationTarget[],
  ms: number,
  deps: TerminationDeps
): Promise<TerminationTarget[]> => {
  const deadline = deps.nowMs() + ms;
  let alive = targets.filter((target) => targetAlive(target, deps));
  while (alive.length > 0 && deps.nowMs() < deadline) {
    await deps.sleep(deps.pollMs);
    alive = alive.filter((target) => targetAlive(target, deps));
  }
  return alive;
};

/**
 * SIGTERM to every target, a bounded grace, then SIGKILL to whatever is still
 * alive and a bounded wait for it to go. Callers pass only targets whose
 * identity they verified; group ids at or below 1 are never signalled.
 */
export const terminateTargets = async (
  targets: readonly TerminationTarget[],
  deps: TerminationDeps
): Promise<TerminationResult> => {
  const seen = new Set<string>();
  const unique = targets.filter((target) => {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key) || !isSignallableGroup(target.id)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const failed: Array<{ reason: string; target: string }> = [];
  for (const target of unique) {
    const reason = sendSignal(target, "SIGTERM", deps);
    if (reason) {
      failed.push({ reason, target: label(target) });
    }
  }
  const afterGrace = await waitUntilGone(unique, deps.graceMs, deps);
  for (const target of afterGrace) {
    const reason = sendSignal(target, "SIGKILL", deps);
    if (reason) {
      failed.push({ reason, target: label(target) });
    }
  }
  const survivors = await waitUntilGone(afterGrace, deps.killWaitMs, deps);
  const killed = new Set(afterGrace);
  return {
    exited: unique.filter((target) => !killed.has(target)).map(label),
    failed,
    killed: afterGrace.map(label),
    survivors: survivors.map(label),
  };
};

const defaultPidAlive = (pid: number): boolean => {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** SIGTERM grace and SIGKILL wait for a teardown or a stale recovery. */
export const GROUP_TERM_GRACE_MS = 3000;
export const GROUP_KILL_WAIT_MS = 1000;

export const defaultTerminationDeps = (): TerminationDeps => ({
  graceMs: GROUP_TERM_GRACE_MS,
  isPidAlive: defaultPidAlive,
  killWaitMs: GROUP_KILL_WAIT_MS,
  nowMs: () => Date.now(),
  pollMs: 100,
  processGroupAlive,
  signal: (id, signal) => {
    process.kill(id, signal);
  },
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
});

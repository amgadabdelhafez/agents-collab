import { spawnSync } from "node:child_process";
import { isUtilityWorkerCommand } from "./utility-constants";

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

/** One row of the process table: `ps -axo pid=,ppid=,pgid=,lstart=`. */
export interface ProcessRow {
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  /** Start time, truncated to the second by `ps`; `undefined` if unparsable. */
  readonly startedAtMs: number | undefined;
}

const LINE_RE = /\r?\n/;
const ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

/** Parses `pid ppid pgid lstart` lines; malformed lines are dropped. */
export const parseProcessTable = (stdout: string): ProcessRow[] =>
  stdout.split(LINE_RE).flatMap((line) => {
    const match = ROW_RE.exec(line);
    if (!match) {
      return [];
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    const pgid = Number.parseInt(match[3] ?? "", 10);
    const startedAtMs = Date.parse(match[4] ?? "");
    return [
      {
        pgid,
        pid,
        ppid,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined,
      },
    ];
  });

/**
 * The whole process table, or `undefined` when `ps` cannot say. One call per
 * snapshot: a teardown, a stale recovery or a periodic record reads it once.
 */
export const readProcessTable = (): ProcessRow[] | undefined => {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const rows = parseProcessTable(result.stdout);
  return rows.length > 0 ? rows : undefined;
};

/**
 * Every live descendant of `roots` (the roots excluded), by a ppid walk over
 * one snapshot of the table. A process whose parent already exited has been
 * reparented and is not reached; callers snapshot while the parents live.
 */
export const descendantsOf = (
  roots: readonly number[],
  table: readonly ProcessRow[]
): ProcessRow[] => {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    if (row.pid === row.ppid) {
      continue;
    }
    const list = children.get(row.ppid);
    if (list) {
      list.push(row);
    } else {
      children.set(row.ppid, [row]);
    }
  }
  const seen = new Set<number>(roots);
  const found: ProcessRow[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
};

/**
 * Whether a live process that `ps` reports started at `startedAtMs` (truncated
 * to the second) may have existed at `referenceMs`. A start in the same second
 * counts as existing: this errs toward treating it as the recorded one.
 */
const startedBy = (
  startedAtMs: number | undefined,
  referenceMs: number
): boolean => startedAtMs !== undefined && startedAtMs <= referenceMs;

/**
 * Whether a termination target is still the thing that was recorded, judged
 * on one table snapshot right before it is signalled. A target without a
 * reference instant is trusted as identified by its caller.
 *
 * A group: some live member started by the reference. A group id reused after
 * the recorded group emptied belongs to a group created later, and a process
 * joins a group only from inside that group's session, which holds only the
 * new leader's descendants; so every member of a reused group started after
 * the reference. A process: the live process holding the id started by then.
 */
export const targetStillRecorded = (
  target: TerminationTarget,
  table: readonly ProcessRow[]
): boolean => {
  if (target.reference === undefined) {
    return true;
  }
  const referenceMs = Date.parse(target.reference);
  if (!Number.isFinite(referenceMs)) {
    return false;
  }
  return table.some(
    (row) =>
      (target.kind === "group" ? row.pgid : row.pid) === target.id &&
      startedBy(row.startedAtMs, referenceMs)
  );
};

/** The identity a utility worker target is re-verified against. */
export interface UtilityWorkerIdentity {
  readonly epoch: number;
  readonly jobId: string;
  readonly runDir: string;
}

/** One thing a teardown or stale recovery ends: a whole group, or one process. */
export interface TerminationTarget {
  readonly id: number;
  /**
   * A utility worker's identity: right before every signal round, a live
   * leader (pid `id`) must still run the worker command of exactly this run
   * directory, epoch and job, or the target is reported `unverified`.
   */
  readonly identity?: UtilityWorkerIdentity;
  readonly kind: "group" | "process";
  /**
   * `inferred`: the run holds the group only because the ppid walk found it
   * (an `agent-group-*` record). Such a target is never signalled while the
   * other runs cannot be read (see `shared-process-ownership`).
   */
  readonly ownership?: "inferred";
  /**
   * A moment by which the recorded group (or process) certainly existed. When
   * present, the target is re-identified right before every signal round (see
   * `targetStillRecorded`) and reported `unverified`, never signalled, once it
   * is no longer provably the recorded one.
   */
  readonly reference?: string;
  /** The ownership rule that made it a target, when not the plain one. */
  readonly rule?: string;
  readonly source: string;
}

/** Why a target another run may hold was not signalled. */
export interface SharedTargetSkipEntry {
  readonly detail: string;
  readonly otherRunId?: string;
  readonly reason: "ownership-unknown" | "shared-process-skipped";
}

export interface TerminationDeps {
  graceMs: number;
  isPidAlive: (pid: number) => boolean;
  killWaitMs: number;
  nowMs: () => number;
  pollMs: number;
  processGroupAlive: (pgid: number) => boolean;
  /**
   * Right before every signal round, the targets another live run records or
   * names (or whose ownership cannot be judged), by `kind:id` key. They are
   * reported in `shared` and never signalled. Absent, none is skipped.
   */
  sharedSkips?: (
    targets: readonly TerminationTarget[]
  ) => ReadonlyMap<string, SharedTargetSkipEntry>;
  /** `process.kill`: a negative id signals the group. */
  signal: (id: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  /**
   * Re-identifies the targets that carry a reference instant, right before a
   * signal round, as the set of `kind:id` keys still provably the recorded
   * group or process. Absent, every target is trusted as identified.
   */
  stillRecorded?: (targets: readonly TerminationTarget[]) => Set<string>;
}

export interface TerminationResult {
  /** Gone within the SIGTERM grace (or already gone). */
  readonly exited: string[];
  /** A signal that failed with anything but ESRCH. */
  readonly failed: Array<{ reason: string; target: string }>;
  /** Still alive after the grace, so sent SIGKILL. */
  readonly killed: string[];
  /**
   * Targets another live run records or names (`shared-process-skipped`), or
   * whose ownership could not be judged (`ownership-unknown`): never
   * signalled. Present only when non-empty.
   */
  readonly shared?: Array<SharedTargetSkipEntry & { target: string }>;
  /** Still alive after SIGKILL and its wait: the release must not proceed. */
  readonly survivors: string[];
  /**
   * Live, but no longer provably the recorded group or process (its id was
   * reused after the record), so never signalled. Present only when
   * non-empty; the release evidence still judges the record.
   */
  readonly unverified?: string[];
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
  const unverified: TerminationTarget[] = [];
  const shared = new Map<
    TerminationTarget,
    SharedTargetSkipEntry & { target: string }
  >();
  const checked = (target: TerminationTarget): boolean =>
    target.reference !== undefined || target.identity !== undefined;
  // Re-identify right before each signal round: a target recorded earlier
  // (before a slow beat close, or a grace) whose id was reused since is
  // dropped and never signalled, and so is one another live run now records
  // or names.
  const identified = (
    targets: readonly TerminationTarget[]
  ): TerminationTarget[] => {
    const referenced = targets.filter(checked);
    const still =
      deps.stillRecorded && referenced.length > 0
        ? deps.stillRecorded(referenced)
        : undefined;
    const recorded = targets.filter((target) => {
      if (
        !(still && checked(target)) ||
        still.has(`${target.kind}:${target.id}`)
      ) {
        return true;
      }
      if (targetAlive(target, deps)) {
        unverified.push(target);
      }
      return false;
    });
    const skips =
      deps.sharedSkips && recorded.length > 0
        ? deps.sharedSkips(recorded)
        : undefined;
    if (!skips || skips.size === 0) {
      return recorded;
    }
    return recorded.filter((target) => {
      const skip = skips.get(`${target.kind}:${target.id}`);
      if (!skip) {
        return true;
      }
      shared.set(target, { ...skip, target: label(target) });
      return false;
    });
  };
  const termTargets = identified(unique);
  for (const target of termTargets) {
    const reason = sendSignal(target, "SIGTERM", deps);
    if (reason) {
      failed.push({ reason, target: label(target) });
    }
  }
  const afterGrace = identified(
    await waitUntilGone(termTargets, deps.graceMs, deps)
  );
  for (const target of afterGrace) {
    const reason = sendSignal(target, "SIGKILL", deps);
    if (reason) {
      failed.push({ reason, target: label(target) });
    }
  }
  const survivors = await waitUntilGone(afterGrace, deps.killWaitMs, deps);
  const killed = new Set(afterGrace);
  const skipped = new Set(unverified);
  return {
    // Gone within the grace, or already gone when re-identified.
    exited: unique
      .filter(
        (target) =>
          !(killed.has(target) || skipped.has(target) || shared.has(target))
      )
      .map(label),
    failed,
    killed: afterGrace.map(label),
    survivors: survivors.map(label),
    ...(unverified.length > 0 ? { unverified: unverified.map(label) } : {}),
    ...(shared.size > 0 ? { shared: [...shared.values()] } : {}),
  };
};

/**
 * The re-identification on one table snapshot: the reference rule
 * (`targetStillRecorded`), and for a utility worker target whose leader is
 * still in the table, its command must still be the worker command of exactly
 * its run directory, epoch and job (`commandOf` is asked only then; an
 * unreadable command is not the worker).
 */
export const stillRecordedOn = (
  targets: readonly TerminationTarget[],
  table: readonly ProcessRow[],
  commandOf: (pid: number) => string | undefined
): Set<string> =>
  new Set(
    targets
      .filter((target) => {
        if (!targetStillRecorded(target, table)) {
          return false;
        }
        const identity = target.identity;
        if (!(identity && table.some((row) => row.pid === target.id))) {
          return true;
        }
        return isUtilityWorkerCommand(commandOf(target.id), identity);
      })
      .map((target) => `${target.kind}:${target.id}`)
  );

/** `ps -o command= -p <pid>`, or `undefined`. */
export const readCommandOf = (pid: number): string | undefined => {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return undefined;
  }
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-o", "command=", "-p", String(pid)],
    { encoding: "utf8", timeout: 1000 }
  );
  const command = result.stdout?.trim();
  return result.status === 0 && !result.error && command ? command : undefined;
};

/** The default re-identification: one process table snapshot per round. */
const defaultStillRecorded = (
  targets: readonly TerminationTarget[]
): Set<string> => {
  const table = readProcessTable();
  if (!table) {
    // Without a table nothing can be re-identified: signal none of them.
    return new Set();
  }
  return stillRecordedOn(targets, table, readCommandOf);
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
  stillRecorded: defaultStillRecorded,
});

import { spawn } from "node:child_process";
import { sleep } from "bun";
import type { HeadlessRunResult } from "./headless-claude-wake-port";

/**
 * Runs a child process to completion under a deadline, capturing its output.
 *
 * The wake port is written against an injected runner so its judgement can be
 * tested without starting anything; this is the one real implementation.
 *
 * The child is spawned DETACHED, which makes it the leader of a new process
 * group, and the deadline signals that whole group. That is what actually
 * cleans up: signalling only the child leaves a backgrounded grandchild
 * running, and that grandchild inherits stdout and stderr, so it also keeps
 * those pipes open long after its parent is gone. An earlier version killed
 * only the child and waited for end-of-output, which hung at five seconds
 * against a 300ms deadline; the version after that returned promptly but left
 * the descendant alive. Signalling the group fixes both.
 *
 * Only this runner's own group is ever signalled, so nothing else on the host
 * is touched.
 */
const KILL_GRACE_MS = 2000;
// Signal 0 tests for existence without delivering anything.
const EXISTS = 0;
// A killed group is not gone the instant the signal is sent, so existence is
// re-checked briefly before calling it a failure. Without this the check races
// the kernel and reports a leak that is merely a process not yet reaped.
const REAP_CHECK_MS = 100;
const REAP_CHECKS = 8;
const OUTPUT_LIMIT = 1_048_576;

type SignalOutcome = "absent" | "failed" | "signalled";

/**
 * Signals the group this runner started, and nothing else. ESRCH means the
 * group is already gone, which is success; anything else (EPERM, for instance)
 * is a real cleanup failure and must not be reported as "already gone".
 */
const signalGroup = (
  pid: number | undefined,
  signal: NodeJS.Signals | 0
): SignalOutcome => {
  if (pid === undefined) {
    return "absent";
  }
  try {
    // Negative pid means "the group this pid leads", which is the tree we
    // started and nothing else.
    process.kill(-pid, signal as NodeJS.Signals);
    return "signalled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "absent"
      : "failed";
  }
};

const stillPresent = async (pid: number | undefined): Promise<boolean> => {
  for (let check = 0; check < REAP_CHECKS; check += 1) {
    if (signalGroup(pid, EXISTS) === "absent") {
      return false;
    }
    await sleep(REAP_CHECK_MS);
  }
  return signalGroup(pid, EXISTS) !== "absent";
};

export const spawnHeadless = (input: {
  argv: readonly string[];
  timeoutMs: number;
}): Promise<HeadlessRunResult> => {
  const [command, ...args] = input.argv;
  if (!command) {
    return Promise.reject(new Error("spawnHeadless needs a command"));
  }
  return new Promise<HeadlessRunResult>((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      // No stdin: a wake is not interactive, and an inherited one would let a
      // child consume the service's own input.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const collect = (into: "err" | "out") => (chunk: Buffer) => {
      const text = chunk.toString();
      if (into === "out") {
        stdout = (stdout + text).slice(0, OUTPUT_LIMIT);
        return;
      }
      stderr = (stderr + text).slice(0, OUTPUT_LIMIT);
    };
    child.stdout?.on("data", collect("out"));
    child.stderr?.on("data", collect("err"));

    let cleanupFailed = false;
    /**
     * Settling the RESULT and finishing the CLEANUP are separate concerns.
     * Review reproduced the leak this fixes: a parent that exits promptly on
     * the polite signal settles the run, and if that cancelled the escalation,
     * a signal-resistant descendant survived. Escalation is therefore never
     * cancelled once a timeout has started.
     */
    const done = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      // Stop reading: an abandoned reader would keep collecting from a
      // descendant that still holds the pipe.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        code,
        stderr,
        stdout,
        ...(cleanupFailed ? { cleanupFailed } : {}),
        ...(timedOut ? { timedOut } : {}),
      });
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      if (signalGroup(child.pid, "SIGTERM") === "failed") {
        cleanupFailed = true;
      }
      // Deliberately not cleared by `done`, and not unref'd: the group must be
      // finished off whether or not the parent already exited.
      setTimeout(async () => {
        const killed = signalGroup(child.pid, "SIGKILL");
        if (killed === "failed") {
          cleanupFailed = true;
        }
        // Verified rather than assumed: still present after an uncatchable
        // signal is a cleanup failure the caller must hear about. Checked over
        // a bounded window, because a killed group is not gone the instant the
        // signal is sent, and an immediate check races the kernel reaping it
        // and reports a leak that is not one.
        if (killed !== "absent" && (await stillPresent(child.pid))) {
          cleanupFailed = true;
        }
        done(-1);
      }, KILL_GRACE_MS);
    }, input.timeoutMs);

    child.on("error", () => done(-1));
    /**
     * After a timeout the child's exit does NOT settle the run unless the whole
     * group is already gone. Review found that settling here hid a later
     * escalation failure: the result object was already resolved, so a failing
     * SIGKILL set a flag nobody would ever read. The wait is bounded by the
     * grace period, and skipped entirely when there is nothing left to stop.
     */
    child.on("close", (code) => {
      if (!timedOut) {
        done(code ?? -1);
        return;
      }
      if (signalGroup(child.pid, EXISTS) === "absent") {
        done(code ?? -1);
      }
    });
  });
};

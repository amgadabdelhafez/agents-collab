import { type ChildProcess, spawn } from "node:child_process";
import { spawnSync } from "bun";
import { spawnParts, type TmuxTarget, targetArgv } from "./tmux-socket";

export const TMUX_CONTROL_TIMEOUT_MS = 2000;
export const TMUX_CONTROL_KILL_SIGNAL = "SIGKILL" as const;

export type TmuxLiveness = "dead" | "live" | "unknown";

export class TmuxControlUnavailableError extends Error {
  readonly args: string[];

  constructor(args: string[], cause?: unknown) {
    super(`tmux control unavailable: tmux ${args.join(" ")}`, { cause });
    this.name = "TmuxControlUnavailableError";
    this.args = [...args];
  }
}

export const isTmuxControlUnavailableError = (
  error: unknown
): error is TmuxControlUnavailableError =>
  error instanceof TmuxControlUnavailableError;

interface TmuxCommandResult {
  exitCode: number;
  signalCode?: string | null;
}

export const boundedTmuxOptions = <const T extends object>(
  options: T
): T & {
  killSignal: typeof TMUX_CONTROL_KILL_SIGNAL;
  timeout: typeof TMUX_CONTROL_TIMEOUT_MS;
} => ({
  ...options,
  killSignal: TMUX_CONTROL_KILL_SIGNAL,
  timeout: TMUX_CONTROL_TIMEOUT_MS,
});

export const tmuxCommandTimedOut = (result: TmuxCommandResult): boolean =>
  Boolean(result.signalCode);

export const tmuxSessionLiveness = (
  session: string,
  run: typeof spawnSync = spawnSync
): TmuxLiveness => {
  if (!session) {
    // NOT "dead". An absent session name is absence of evidence, not evidence
    // of absence — it is what a legacy manifest looks like. "dead" is the
    // verdict that grants cleanup authority, so returning it here lets a
    // caller signal PIDs and remove config for a run that may be perfectly
    // alive on a server nobody asked about (verify 10).
    return "unknown";
  }
  try {
    const result = run(
      ["tmux", "has-session", "-t", session],
      boundedTmuxOptions({ stderr: "ignore", stdout: "ignore" })
    );
    if (tmuxCommandTimedOut(result)) {
      return "unknown";
    }
    return result.exitCode === 0 ? "live" : "dead";
  } catch {
    return "unknown";
  }
};

export const tmuxSessionLivenessAsync = (
  session: string,
  run: typeof spawn = spawn
): Promise<TmuxLiveness> => {
  if (!session) {
    // Same fail-closed rule as the sync path above.
    return Promise.resolve("unknown");
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess | undefined;
    const finish = (liveness: TmuxLiveness) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(liveness);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill(TMUX_CONTROL_KILL_SIGNAL);
      finish("unknown");
    }, TMUX_CONTROL_TIMEOUT_MS);
    try {
      child = run("tmux", ["has-session", "-t", session], {
        stdio: "ignore",
      });
      child.once("error", () => finish("unknown"));
      child.once("exit", (code, signal) => {
        if (timedOut || signal) {
          finish("unknown");
          return;
        }
        finish(code === 0 ? "live" : "dead");
      });
    } catch {
      finish("unknown");
    }
  });
};

// --- Target-bound liveness --------------------------------------------------
// The socket-blind `tmuxSessionLiveness` pair above asks "does a session with
// this name exist on whatever server my environment points at". That question
// has the wrong shape: a same-named session on another server answers "live"
// and a live run on its own server answers "dead". These take the run's own
// target, so the server is named by the manifest rather than by ambient state.
// Consumers migrate to these; the session-bound pair is retired once none
// remain (T-06, T-08, T-10).

export const NO_SESSION_RE =
  /no server running|no sessions|can't find session|couldn't find session|session.*not found/i;
export const MISSING_TMUX_SOCKET_RE =
  /error connecting to .*\(No such file or directory\)/i;

export const isConfirmedMissingTmuxSession = (
  detail: string,
  allowMissingSocket = false
): boolean =>
  NO_SESSION_RE.test(detail) ||
  (allowMissingSocket && MISSING_TMUX_SOCKET_RE.test(detail));

/**
 * Liveness of a run on its own server. `undefined` means the manifest yielded
 * no usable target — legacy or unusable — which is `"unknown"`, never
 * `"dead"`: `"dead"` grants cleanup authority and an absent target is not
 * evidence a run stopped (verify 10).
 */
export const tmuxTargetLiveness = (
  target: TmuxTarget | undefined,
  run: typeof spawnSync = spawnSync
): TmuxLiveness => {
  if (!target) {
    return "unknown";
  }
  try {
    const result = run(
      targetArgv(target, "has-session"),
      boundedTmuxOptions({ stderr: "pipe", stdout: "ignore" })
    );
    if (tmuxCommandTimedOut(result)) {
      return "unknown";
    }
    if (result.exitCode === 0) {
      return "live";
    }
    const stderr =
      typeof result.stderr === "string"
        ? result.stderr
        : Buffer.from(result.stderr ?? "").toString("utf8");
    return isConfirmedMissingTmuxSession(stderr) ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
};

/** Async form, with the same bounded-timeout and unknown semantics. */
export const tmuxTargetLivenessAsync = (
  target: TmuxTarget | undefined,
  run: typeof spawn = spawn
): Promise<TmuxLiveness> => {
  if (!target) {
    return Promise.resolve("unknown");
  }
  const { args, command } = spawnParts(targetArgv(target, "has-session"));
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess | undefined;
    let stderrText = "";
    const finish = (liveness: TmuxLiveness) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(liveness);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill(TMUX_CONTROL_KILL_SIGNAL);
      finish("unknown");
    }, TMUX_CONTROL_TIMEOUT_MS);
    try {
      child = run(command, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk: string | Buffer) => {
        stderrText +=
          typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      child.once("error", () => finish("unknown"));
      child.once("close", (code, signal) => {
        if (timedOut || signal) {
          finish("unknown");
          return;
        }
        if (code === 0) {
          finish("live");
          return;
        }
        finish(
          code !== null && isConfirmedMissingTmuxSession(stderrText)
            ? "dead"
            : "unknown"
        );
      });
    } catch {
      finish("unknown");
    }
  });
};

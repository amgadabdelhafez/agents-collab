import { type ChildProcess, spawn } from "node:child_process";
import { spawnSync } from "bun";

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
    return "dead";
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
    return Promise.resolve("dead");
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

export const tmuxPaneLiveness = (
  session: string,
  pane: string,
  run: typeof spawnSync = spawnSync
): TmuxLiveness => {
  if (tmuxSessionLiveness(session, run) !== "live") {
    return "unknown";
  }
  try {
    const result = run(
      [
        "tmux",
        "display-message",
        "-p",
        "-t",
        pane,
        "#{session_name}\t#{pane_id}\t#{pane_dead}",
      ],
      boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" })
    );
    if (tmuxCommandTimedOut(result)) {
      return "unknown";
    }
    if (result.exitCode !== 0) {
      return "dead";
    }
    const output = result.stdout?.toString().trim() ?? "";
    const fields = output.split("\t");
    if (fields.length !== 3) {
      return "unknown";
    }
    const [actualSession, actualPane, paneDead] = fields;
    if (
      actualSession !== session ||
      !actualPane.startsWith("%") ||
      (pane.startsWith("%") && actualPane !== pane)
    ) {
      return "unknown";
    }
    if (paneDead === "0") {
      return "live";
    }
    return paneDead === "1" ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
};

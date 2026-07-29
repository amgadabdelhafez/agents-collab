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

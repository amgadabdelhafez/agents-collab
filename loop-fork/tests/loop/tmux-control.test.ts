import { expect, test } from "bun:test";
import type { spawnSync } from "bun";
import {
  TMUX_CONTROL_KILL_SIGNAL,
  TMUX_CONTROL_TIMEOUT_MS,
  tmuxSessionLiveness,
} from "../../src/loop/tmux-control";

interface RecordedCall {
  args: string[];
  options: Record<string, unknown>;
}

const fakeSpawn = (
  result: { exitCode: number; signalCode?: string | null },
  calls: RecordedCall[]
): typeof spawnSync =>
  ((args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    return result;
  }) as unknown as typeof spawnSync;

test("tmux liveness probes are bounded and kill the timed-out client", () => {
  const calls: RecordedCall[] = [];
  expect(
    tmuxSessionLiveness(
      "repo-loop-98",
      fakeSpawn({ exitCode: 0, signalCode: "SIGKILL" }, calls)
    )
  ).toBe("unknown");
  expect(calls).toEqual([
    {
      args: ["tmux", "has-session", "-t", "repo-loop-98"],
      options: {
        killSignal: TMUX_CONTROL_KILL_SIGNAL,
        stderr: "ignore",
        stdout: "ignore",
        timeout: TMUX_CONTROL_TIMEOUT_MS,
      },
    },
  ]);
});

test("tmux liveness distinguishes confirmed live and dead sessions", () => {
  expect(tmuxSessionLiveness("live", fakeSpawn({ exitCode: 0 }, []))).toBe(
    "live"
  );
  expect(tmuxSessionLiveness("dead", fakeSpawn({ exitCode: 1 }, []))).toBe(
    "dead"
  );
  expect(
    tmuxSessionLiveness("error", (() => {
      throw new Error("tmux unavailable");
    }) as typeof spawnSync)
  ).toBe("unknown");
});

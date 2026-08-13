import { expect, test } from "bun:test";
import type { spawnSync } from "bun";
import {
  TMUX_CONTROL_KILL_SIGNAL,
  TMUX_CONTROL_TIMEOUT_MS,
  tmuxPaneLiveness,
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

interface SpawnResult {
  exitCode: number;
  signalCode?: string | null;
  stdout?: string;
}

const fakeSpawnSequence = (
  calls: RecordedCall[],
  results: Array<Error | SpawnResult>
): typeof spawnSync =>
  ((args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    const result = results[calls.length - 1];
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as unknown as typeof spawnSync;

test("tmux pane liveness verifies the exact live pane with bounded probes", () => {
  const calls: RecordedCall[] = [];
  expect(
    tmuxPaneLiveness(
      "repo-loop-98",
      "%5",
      fakeSpawnSequence(calls, [
        { exitCode: 0 },
        { exitCode: 0, stdout: "repo-loop-98\t%5\t0" },
      ])
    )
  ).toBe("live");
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
    {
      args: [
        "tmux",
        "display-message",
        "-p",
        "-t",
        "%5",
        "#{session_name}\t#{pane_id}\t#{pane_dead}",
      ],
      options: {
        killSignal: TMUX_CONTROL_KILL_SIGNAL,
        stderr: "ignore",
        stdout: "pipe",
        timeout: TMUX_CONTROL_TIMEOUT_MS,
      },
    },
  ]);
});

test("tmux pane liveness distinguishes a dead or absent pane only in a live session", () => {
  expect(
    tmuxPaneLiveness(
      "repo-loop-98",
      "%5",
      fakeSpawnSequence(
        [],
        [{ exitCode: 0 }, { exitCode: 0, stdout: "repo-loop-98\t%5\t1" }]
      )
    )
  ).toBe("dead");
});

test("tmux pane liveness fails closed when session evidence is not live", () => {
  for (const sessionResult of [
    { exitCode: 1 },
    { exitCode: 0, signalCode: "SIGKILL" },
    new Error("tmux unavailable"),
  ]) {
    const calls: RecordedCall[] = [];
    expect(
      tmuxPaneLiveness(
        "repo-loop-98",
        "%5",
        fakeSpawnSequence(calls, [sessionResult])
      )
    ).toBe("unknown");
    expect(calls).toHaveLength(1);
  }
});

test("tmux pane liveness fails closed on invalid pane evidence", () => {
  const paneResults: Array<Error | SpawnResult> = [
    { exitCode: 0, signalCode: "SIGKILL" },
    { exitCode: 1 },
    new Error("pane probe failed"),
    { exitCode: 0, stdout: "garbage" },
    { exitCode: 0, stdout: "other-session\t%5\t0" },
    { exitCode: 0, stdout: "repo-loop-98\t%6\t0" },
    { exitCode: 0, stdout: "repo-loop-98\t5\t0" },
  ];
  for (const paneResult of paneResults) {
    expect(
      tmuxPaneLiveness(
        "repo-loop-98",
        "%5",
        fakeSpawnSequence([], [{ exitCode: 0 }, paneResult])
      )
    ).toBe("unknown");
  }
});

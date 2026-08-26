import { expect, test } from "bun:test";
import type { spawnSync } from "bun";
import {
  captureTmuxAdapterIdentity,
  createTmuxAdapterContext,
  parseDarwinProcessBirthId,
  parseLinuxProcessBirthId,
  TMUX_CONTROL_KILL_SIGNAL,
  TMUX_CONTROL_TIMEOUT_MS,
  tmuxAdapterSessionLiveness,
  tmuxSessionLiveness,
} from "../../src/loop/tmux-control";

interface RecordedCall {
  args: string[];
  options: Record<string, unknown>;
}

const fakeSpawn = (
  result: {
    exitCode: number;
    signalCode?: string | null;
    stderr?: string;
    stdout?: string;
  },
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

test("process birth parsers require strict positive Darwin and Linux identity", () => {
  expect(parseDarwinProcessBirthId("Tue Aug 25 14:29:46 2026")).toMatch(
    /^darwin:[1-9][0-9]+$/
  );
  expect(parseDarwinProcessBirthId("garbage")).toBeUndefined();
  expect(
    parseLinuxProcessBirthId(
      "4242 (tmux server worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20"
    )
  ).toBe("linux:987654");
  expect(
    parseLinuxProcessBirthId(
      "4242 (tmux) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 0"
    )
  ).toBeUndefined();
});

test("adapter capture canonicalizes only the socket parent and records birth", () => {
  const calls: RecordedCall[] = [];
  const identity = captureTmuxAdapterIdentity("same-name", {
    canonicalizeParent: (parent) => `/canonical${parent}`,
    readProcessBirthId: (pid) =>
      pid === 4242 ? "darwin:1787693386000" : undefined,
    run: fakeSpawn(
      {
        exitCode: 0,
        stdout: "/tmp/socket-parent/server.sock\t4242\n",
      },
      calls
    ),
  });

  expect(identity).toEqual({
    processBirthId: "darwin:1787693386000",
    serverPid: 4242,
    socketPath: "/canonical/tmp/socket-parent/server.sock",
    version: 1,
  });
  expect(calls[0]?.args).toEqual([
    "tmux",
    "display-message",
    "-p",
    "-t",
    "same-name",
    "#{socket_path}\t#{pid}",
  ]);
});

test("adapter diagnostics revalidate identity and always use exact socket", () => {
  const identity = {
    processBirthId: "darwin:1787693386000",
    serverPid: 4242,
    socketPath: "/tmp/a/server.sock",
    version: 1 as const,
  };
  const context = createTmuxAdapterContext(identity);
  const calls: RecordedCall[] = [];
  const outputs = [
    { exitCode: 0, stdout: "/tmp/a/server.sock\t4242\n" },
    { exitCode: 0, stdout: "" },
  ];
  const run = ((args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    return outputs.shift() ?? { exitCode: 1, stdout: "" };
  }) as unknown as typeof spawnSync;

  expect(
    tmuxAdapterSessionLiveness(context, "same-name", {
      canonicalizeParent: (parent) => parent,
      readProcessBirthId: () => "darwin:1787693386000",
      run,
    })
  ).toBe("live");
  expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
    ["tmux", "-S", "/tmp/a/server.sock"],
    ["tmux", "-S", "/tmp/a/server.sock"],
  ]);

  expect(
    tmuxAdapterSessionLiveness(context, "same-name", {
      canonicalizeParent: (parent) => parent,
      readProcessBirthId: () => "darwin:1787693386001",
      run: fakeSpawn({ exitCode: 0, stdout: "/tmp/a/server.sock\t4242\n" }, []),
    })
  ).toBe("unknown");
});

test("adapter capture rejects timeouts and malformed server identity", () => {
  expect(() =>
    captureTmuxAdapterIdentity("same-name", {
      run: fakeSpawn({ exitCode: 0, signalCode: "SIGKILL" }, []),
    })
  ).toThrow("tmux control unavailable");
  expect(() =>
    captureTmuxAdapterIdentity("same-name", {
      readProcessBirthId: () => "darwin:1787693386000",
      run: fakeSpawn({ exitCode: 0, stdout: "not-an-identity\n" }, []),
    })
  ).toThrow("tmux control unavailable");
});

test("adapter diagnostics reject a different socket server", () => {
  const context = createTmuxAdapterContext({
    processBirthId: "darwin:1787693386000",
    serverPid: 4242,
    socketPath: "/tmp/a/server.sock",
    version: 1,
  });
  expect(
    tmuxAdapterSessionLiveness(context, "same-name", {
      canonicalizeParent: (parent) => parent,
      readProcessBirthId: () => "darwin:1787693386000",
      run: fakeSpawn({ exitCode: 0, stdout: "/tmp/b/server.sock\t4242\n" }, []),
    })
  ).toBe("unknown");
});

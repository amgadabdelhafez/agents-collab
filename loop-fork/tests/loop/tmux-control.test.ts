import { expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { spawnSync } from "bun";
import {
  TMUX_CONTROL_KILL_SIGNAL,
  TMUX_CONTROL_TIMEOUT_MS,
  tmuxTargetLiveness,
  tmuxTargetLivenessAsync,
} from "../../src/loop/tmux-control";
import {
  createManifestHandle,
  type TmuxTarget,
  targetFromManifest,
} from "../../src/loop/tmux-socket";

interface RecordedCall {
  args: string[];
  options: Record<string, unknown>;
}

const fakeSpawn = (
  result: { exitCode: number; signalCode?: string | null; stderr?: string },
  calls: RecordedCall[]
): typeof spawnSync =>
  ((args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    return result;
  }) as unknown as typeof spawnSync;

// --- target-bound liveness (T-05 cascade landing point) ----------------------

const targetFor = (
  socket = "/tmp/ls-a/a.sock",
  session = "run-a"
): TmuxTarget | undefined =>
  targetFromManifest(
    createManifestHandle({
      manifestPath: "/tmp/ls-a/manifest.json",
      manifestSha256: "a".repeat(64),
      platform: "darwin",
      runId: "run-a",
      session,
      socket,
    })
  );

test("target-bound liveness names the run's own socket, not the ambient one", () => {
  const calls: RecordedCall[] = [];
  expect(
    tmuxTargetLiveness(targetFor(), fakeSpawn({ exitCode: 0 }, calls))
  ).toBe("live");
  // The whole point: -S must be present and must carry the manifest's socket.
  expect(calls[0]?.args).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "has-session",
    "-t",
    "run-a",
  ]);
});

test("an unusable target reads unknown and contacts no server", () => {
  // A legacy manifest yields no target. "dead" would grant cleanup authority
  // over a run that may be alive on a server nobody asked about (verify 10).
  const calls: RecordedCall[] = [];
  expect(tmuxTargetLiveness(undefined, fakeSpawn({ exitCode: 1 }, calls))).toBe(
    "unknown"
  );
  expect(calls).toEqual([]);
});

test("target-bound liveness keeps the bounded-timeout semantics (verify 17)", () => {
  const calls: RecordedCall[] = [];
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn({ exitCode: 0, signalCode: "SIGKILL" }, calls)
    )
  ).toBe("unknown");
  expect(calls[0]?.options).toMatchObject({
    killSignal: TMUX_CONTROL_KILL_SIGNAL,
    timeout: TMUX_CONTROL_TIMEOUT_MS,
  });
});

test("a nonzero exit with empty stderr is unknown, not dead", () => {
  // Without a POSIX-confirmed dead signal in stderr, a nonzero exit alone is
  // not authority to classify as dead. Empty stderr cannot distinguish
  // "session not found" from a transport or server error, so the safe
  // classification is unknown.
  const calls: RecordedCall[] = [];
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn({ exitCode: 1, stderr: "" }, calls)
    )
  ).toBe("unknown");
});

test("can't-find-session stderr on the run's own server is genuinely dead", () => {
  // The server answered and told us the session does not exist. That is
  // positive evidence of absence, not mere failure to confirm presence.
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn({ exitCode: 1, stderr: "can't find session: run-a\n" }, [])
    )
  ).toBe("dead");
});

test("no-server-running stderr on the run's own socket is genuinely dead", () => {
  // The target names the exact socket. If no server is running on that
  // socket, the session cannot exist there — dead is real.
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn(
        { exitCode: 1, stderr: "no server running on /tmp/ls-a/a.sock\n" },
        []
      )
    )
  ).toBe("dead");
});

test("ENOENT socket stderr is unknown, not dead", () => {
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn(
        {
          exitCode: 1,
          stderr:
            "error connecting to /tmp/ls-a/a.sock (No such file or directory)\n",
        },
        []
      )
    )
  ).toBe("unknown");
});

test("file-name-too-long socket stderr is unknown, not dead", () => {
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn(
        {
          exitCode: 1,
          stderr: "error connecting to /tmp/ls-a/a.sock (File name too long)\n",
        },
        []
      )
    )
  ).toBe("unknown");
});

test("non-socket stderr is unknown, not dead", () => {
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn(
        {
          exitCode: 1,
          stderr: "error connecting to /tmp/ls-a/a.sock (Not a socket)\n",
        },
        []
      )
    )
  ).toBe("unknown");
});

test("permission-denied stderr is unknown, not dead", () => {
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn(
        {
          exitCode: 1,
          stderr: "error connecting to /tmp/ls-a/a.sock (Permission denied)\n",
        },
        []
      )
    )
  ).toBe("unknown");
});

test("unrecognised stderr is unknown, not dead", () => {
  expect(
    tmuxTargetLiveness(
      targetFor(),
      fakeSpawn({ exitCode: 1, stderr: "something unexpected happened\n" }, [])
    )
  ).toBe("unknown");
});

test("a spawn throw on the target path reads unknown", () => {
  expect(
    tmuxTargetLiveness(targetFor(), (() => {
      throw new Error("spawn tmux ENOENT");
    }) as typeof spawnSync)
  ).toBe("unknown");
});

test("the async target path resolves unknown for an unusable target", async () => {
  await expect(tmuxTargetLivenessAsync(undefined)).resolves.toBe("unknown");
});

// --- Async target-bound classification ----------------------------------------

class FakeChildProcess extends EventEmitter {
  readonly stderr: EventEmitter;
  killed = false;

  constructor() {
    super();
    this.stderr = new EventEmitter();
  }

  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

const fakeAsyncSpawn = (
  handler: (child: FakeChildProcess) => void
): typeof spawn =>
  ((_command: string, _args: string[], _options: Record<string, unknown>) => {
    const child = new FakeChildProcess();
    setTimeout(() => handler(child), 0);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;

test("async target liveness: exit zero is live", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    })
  );
  await expect(promise).resolves.toBe("live");
});

test("async target liveness: can't-find-session stderr is dead", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("exit", 1, null);
      child.stderr.emit("data", Buffer.from("can't find session: run-a\n"));
      child.emit("close", 1, null);
    })
  );
  await expect(promise).resolves.toBe("dead");
});

test("async target liveness: no-server-running stderr is dead", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("exit", 1, null);
      child.stderr.emit(
        "data",
        Buffer.from("no server running on /tmp/ls-a/a.sock\n")
      );
      child.emit("close", 1, null);
    })
  );
  await expect(promise).resolves.toBe("dead");
});

test("async target liveness: empty stderr nonzero exit is unknown", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    })
  );
  await expect(promise).resolves.toBe("unknown");
});

test("async target liveness: unrecognised stderr is unknown", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("exit", 1, null);
      child.stderr.emit("data", Buffer.from("unexpected error\n"));
      child.emit("close", 1, null);
    })
  );
  await expect(promise).resolves.toBe("unknown");
});

for (const [name, stderr] of [
  [
    "ENOENT",
    "error connecting to /tmp/ls-a/a.sock (No such file or directory)\n",
  ],
  [
    "file-name-too-long",
    "error connecting to /tmp/ls-a/a.sock (File name too long)\n",
  ],
  [
    "non-socket",
    "error connecting to /tmp/ls-a/a.sock (Socket operation on non-socket)\n",
  ],
  [
    "permission-denied",
    "error connecting to /tmp/ls-a/a.sock (Permission denied)\n",
  ],
] as const) {
  test(`async target liveness: ${name} stderr is unknown`, async () => {
    const promise = tmuxTargetLivenessAsync(
      targetFor(),
      fakeAsyncSpawn((child) => {
        child.emit("exit", 1, null);
        child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", 1, null);
      })
    );
    await expect(promise).resolves.toBe("unknown");
  });
}

test("async target liveness: signal is unknown before stderr authority", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.stderr.emit("data", Buffer.from("can't find session: run-a\n"));
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    })
  );
  await expect(promise).resolves.toBe("unknown");
});

test("async target liveness: spawn error event is unknown", async () => {
  const promise = tmuxTargetLivenessAsync(
    targetFor(),
    fakeAsyncSpawn((child) => {
      child.emit("error", new Error("spawn tmux ENOENT"));
    })
  );
  await expect(promise).resolves.toBe("unknown");
});

test("async target liveness: spawn throw is unknown", async () => {
  const throwSpawn = (() => {
    throw new Error("spawn tmux ENAMETOOLONG");
  }) as typeof spawn;
  await expect(tmuxTargetLivenessAsync(targetFor(), throwSpawn)).resolves.toBe(
    "unknown"
  );
});

test("async race: exit, then stderr, then close waits for close", async () => {
  let child: FakeChildProcess | undefined;
  const spawnFn = (() => {
    child = new FakeChildProcess();
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  const promise = tmuxTargetLivenessAsync(targetFor(), spawnFn);
  let resolved = false;
  promise.then(() => {
    resolved = true;
  });

  if (!child) {
    throw new Error("fake spawn did not return a child");
  }

  child.emit("exit", 1, null);
  await Promise.resolve();
  expect(resolved).toBe(false);

  child.stderr.emit("data", Buffer.from("can't find session: run-a\n"));
  await Promise.resolve();
  expect(resolved).toBe(false);

  child.emit("close", 1, null);
  await Promise.resolve();
  expect(resolved).toBe(true);
  await expect(promise).resolves.toBe("dead");
});

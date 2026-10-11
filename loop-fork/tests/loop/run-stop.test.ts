// `loop stop <run-id> [--yes]` (fix8-launch-startup).
//
// A failed paired start left preserved for recovery stays non-terminal and
// locks its workspace until something ends it. `loop stop` ends a run the
// way the Governess teardown does: mark it stopped, end its own verified
// processes (app-server, bridge, utility workers), collect its agent groups,
// kill its session, end the groups, and release on the existing evidence.
// Every effect is faked here except the one real-tmux test, which runs a
// private server on a socket in a fresh directory.

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, which } from "bun";
import { STOP_USAGE } from "../../src/loop/constants";
import type { TerminationTarget } from "../../src/loop/process-group";
import {
  type RunProcessCleanupResult,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  type RunManifest,
  type RunStorage,
  readRunManifest,
} from "../../src/loop/run-state";
import {
  defaultRunStopDeps,
  parseStopArgs,
  type RunStopDeps,
  runStopCommand,
  stopRun,
} from "../../src/loop/run-stop";

const UPDATED_AT = "2026-10-11T10:00:00.000Z";
const NOW = "2026-10-11T12:00:00.000Z";
const APP_SERVER = 1003;

interface Fixture {
  dir: string;
  manifestPath: string;
  runDir: string;
  storage: RunStorage;
}

const withRun = async (
  overrides: Partial<RunManifest>,
  run: (fixture: Fixture) => Promise<void>
) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-stop-"));
  const runDir = join(dir, "runs", "repo-1", "1");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  const manifest: RunManifest = {
    ...createRunManifest(
      {
        codexAppServerPid: APP_SERVER,
        codexRemoteUrl: "ws://127.0.0.1:45123",
        cwd: dir,
        mode: "paired",
        pid: 1001,
        repoId: "repo-1",
        runId: "1",
        state: "input-required",
        tmuxSocket: "/tmp/ls-stop/default",
        workspaceBinding: {
          branchRef: "refs/heads/main",
          repoId: "repo-1",
          root: dir,
        },
      },
      UPDATED_AT
    ),
    tmuxPaneLeft: "%1",
    tmuxPaneRight: "%2",
    tmuxSession: "dummy-loop-1",
    updatedAt: UPDATED_AT,
    ...overrides,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const storage: RunStorage = {
    manifestPath,
    repoId: "repo-1",
    runDir,
    runId: "1",
    storageRoot: join(dir, "runs"),
    transcriptPath: join(runDir, "transcript.jsonl"),
  };
  try {
    await run({ dir, manifestPath, runDir, storage });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

const group = (id: number, source: string): TerminationTarget => ({
  id,
  kind: "group",
  reference: UPDATED_AT,
  source,
});

interface Recorder {
  deps: RunStopDeps;
  events: string[];
}

/** Fakes for every effect, recording their order and what they saw. */
const recorder = (
  fixture: Fixture,
  overrides: Partial<RunStopDeps> = {}
): Recorder => {
  const events: string[] = [];
  const stateNow = () => readRunManifest(fixture.manifestPath)?.state;
  const deps: RunStopDeps = {
    cleanupRunProcesses: (runDir, manifest): RunProcessCleanupResult => {
      events.push(`cleanup:${runDir === fixture.runDir}:${manifest.state}`);
      return {
        groups: [group(2001, "utility job j1 worker")],
        killed: [APP_SERVER],
        skipped: [],
      };
    },
    closeBeat: (input) => {
      events.push(`close-beat:${input.runId}`);
      return Promise.resolve();
    },
    collectAgentGroups: (_runDir, manifest): RunProcessCleanupResult => {
      events.push(`collect:${manifest.state}`);
      return {
        groups: [group(3001, "agent pane %1")],
        killed: [],
        skipped: [],
      };
    },
    killSession: (manifestPath, session) => {
      events.push(`kill:${manifestPath === fixture.manifestPath}:${session}`);
      return { kind: "killed" };
    },
    log: (line) => {
      events.push(`log:${line}`);
    },
    now: () => NOW,
    release: (manifestPath, runId, terminalState) => {
      events.push(
        `release:${manifestPath === fixture.manifestPath}:${runId}:${terminalState}:${stateNow()}`
      );
      return Promise.resolve({ detail: "changed", released: true });
    },
    resolveStorage: (runId) => {
      if (runId !== "1") {
        throw new Error(`unexpected run ${runId}`);
      }
      return fixture.storage;
    },
    terminateGroups: (_runDir, _manifestPath, groups) => {
      events.push(`terminate:${groups.map((target) => target.id).join(",")}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, events };
};

// --- Arguments -----------------------------------------------------------------

test("loop stop takes exactly one run id and an optional --yes", () => {
  expect(parseStopArgs(["7"])).toEqual({ runId: "7", yes: false });
  expect(parseStopArgs(["7", "--yes"])).toEqual({ runId: "7", yes: true });
  expect(parseStopArgs(["--yes", "7"])).toEqual({ runId: "7", yes: true });
  expect(parseStopArgs(["-y", "7"])).toEqual({ runId: "7", yes: true });
  for (const bad of [[], ["7", "8"], ["--yes"], ["7", "--force"], ["../7"]]) {
    expect(() => parseStopArgs(bad)).toThrow(`Usage: ${STOP_USAGE}`);
  }
});

test("loop stop of a run that does not exist changes nothing", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture, {
      resolveStorage: () => ({
        ...fixture.storage,
        manifestPath: join(fixture.dir, "missing", "manifest.json"),
      }),
    });
    await expect(stopRun(["1", "--yes"], deps)).rejects.toThrow(
      "run 1 does not exist"
    );
    expect(events).toEqual([]);
  });
});

// --- Confirmation ----------------------------------------------------------------

test("loop stop without --yes and without a terminal refuses and changes nothing", async () => {
  await withRun({}, async (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const { deps, events } = recorder(fixture, { confirm: undefined });
    await expect(stopRun(["1"], deps)).rejects.toThrow(
      "pass --yes to stop it without a prompt"
    );
    expect(events).toEqual([]);
    expect(readFileSync(fixture.manifestPath, "utf8")).toBe(before);
  });
});

test("loop stop asks first, and a no changes nothing", async () => {
  await withRun({}, async (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const questions: string[] = [];
    const { deps, events } = recorder(fixture, {
      confirm: (question) => {
        questions.push(question);
        return Promise.resolve(false);
      },
    });
    expect(await stopRun(["1"], deps)).toBeUndefined();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Stop run 1 (dummy-loop-1, input-required)");
    expect(events.filter((event) => !event.startsWith("log:"))).toEqual([]);
    expect(readFileSync(fixture.manifestPath, "utf8")).toBe(before);
  });
});

test("loop stop proceeds after a yes", async () => {
  await withRun({}, async (fixture) => {
    const { deps } = recorder(fixture, {
      confirm: () => Promise.resolve(true),
    });
    const report = await stopRun(["1"], deps);
    expect(report?.released).toBe(true);
    expect(readRunManifest(fixture.manifestPath)?.state).toBe("stopped");
  });
});

// --- The teardown ----------------------------------------------------------------

test("loop stop --yes tears a preserved failed start down in the Governess order", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture);

    const report = await stopRun(["1", "--yes"], deps);

    expect(events.filter((event) => !event.startsWith("log:"))).toEqual([
      // Marked stopped first: nothing judges it a live run while it ends.
      "cleanup:true:stopped",
      "collect:stopped",
      "kill:true:dummy-loop-1",
      "terminate:2001,3001",
      "release:true:1:stopped:stopped",
      "close-beat:1",
    ]);
    expect(report).toMatchObject({
      ended: [APP_SERVER],
      groups: 2,
      previousState: "input-required",
      released: true,
      runId: "1",
      session: "dummy-loop-1",
      sessionKill: "killed",
      state: "stopped",
    });
    const transcript = readFileSync(
      join(fixture.runDir, "transcript.jsonl"),
      "utf8"
    );
    expect(transcript).toContain('"state":"stopped"');
    expect(transcript).toContain("loop stop");
  });
});

test("loop stop keeps a failed run failed and releases it as failed", async () => {
  await withRun({ state: "failed", status: "failed" }, async (fixture) => {
    const { deps, events } = recorder(fixture);
    const report = await stopRun(["1", "--yes"], deps);
    expect(report?.state).toBe("failed");
    expect(events).toContain("release:true:1:failed:failed");
  });
});

test("loop stop of a session already gone still ends the processes and releases", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture, {
      killSession: () => ({ kind: "absent" }),
    });
    const report = await stopRun(["1", "--yes"], deps);
    expect(report?.sessionKill).toBe("absent");
    expect(events).toContain("terminate:2001,3001");
    expect(events).toContain("release:true:1:stopped:stopped");
  });
});

test("an unconfirmed session kill ends no group and releases nothing", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture, {
      killSession: () => ({ detail: "tmux timed out", kind: "failed" }),
    });
    const report = await stopRun(["1", "--yes"], deps);
    expect(report).toMatchObject({
      released: false,
      sessionKill: "failed",
      state: "stopped",
    });
    expect(report?.releaseDetail).toContain("tmux timed out");
    expect(events.some((event) => event.startsWith("terminate:"))).toBe(false);
    expect(events.some((event) => event.startsWith("release:"))).toBe(false);
  });
});

// --- A2A endpoint (r9 T4) ---------------------------------------------------------

test("loop stop hands the run's A2A endpoint back once the kill is confirmed", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture, {
      releaseA2ALease: (runDir) => {
        events.push(`a2a-release:${runDir === fixture.runDir}`);
        return Promise.resolve({
          changed: true,
          outcome: "released",
          supervisorId: "supervisor:alice",
        });
      },
    });
    const report = await stopRun(["1", "--yes"], deps);
    const order = events.filter((event) => !event.startsWith("log:"));
    expect(order.indexOf("a2a-release:true")).toBeGreaterThan(
      order.indexOf("kill:true:dummy-loop-1")
    );
    expect(report?.a2aRelease).toEqual({
      changed: true,
      outcome: "released",
      supervisorId: "supervisor:alice",
    });
    expect(events).toContain(
      "log:[loop] released the A2A endpoint of supervisor:alice"
    );
    expect(report?.released).toBe(true);
  });
});

test("loop stop releases no A2A endpoint when the kill is unconfirmed, and a failed release never decides the stop", async () => {
  await withRun({}, async (fixture) => {
    const calls: string[] = [];
    const unconfirmed = recorder(fixture, {
      killSession: () => ({ detail: "tmux timed out", kind: "failed" }),
      releaseA2ALease: () => {
        calls.push("a2a-release");
        return Promise.resolve({ outcome: "none" });
      },
    });
    await stopRun(["1", "--yes"], unconfirmed.deps);
    expect(calls).toEqual([]);
  });
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture, {
      releaseA2ALease: () => Promise.reject(new Error("server down")),
    });
    const report = await stopRun(["1", "--yes"], deps);
    expect(report?.released).toBe(true);
    expect(report?.a2aRelease).toBeUndefined();
    expect(events).toContain(
      "log:[loop] stop: A2A endpoint release failed: server down"
    );
  });
  await withRun({}, async (fixture) => {
    const { deps } = recorder(fixture, {
      releaseA2ALease: () => Promise.resolve({ outcome: "none" }),
    });
    const report = await stopRun(["1", "--yes"], deps);
    // No lease, no field: the report of a run that served no one is unchanged.
    expect(report && "a2aRelease" in report).toBe(false);
  });
});

test("loop stop reports a refused release and the command fails", async () => {
  await withRun({}, async (fixture) => {
    const { deps } = recorder(fixture, {
      release: () =>
        Promise.resolve({
          detail: "recorded-process-may-be-live: codexAppServerPid 1003",
          released: false,
        }),
    });
    const printed: string[] = [];
    await expect(
      runStopCommand(["stop", "1", "--yes"], deps, (line) => {
        printed.push(line);
      })
    ).rejects.toThrow(
      "run 1 was stopped, but its workspace was not released: recorded-process-may-be-live: codexAppServerPid 1003"
    );
    expect(JSON.parse(printed.join(""))).toMatchObject({
      released: false,
      runId: "1",
      state: "stopped",
    });
  });
});

test("runStopCommand ignores every other command", async () => {
  await withRun({}, async (fixture) => {
    const { deps, events } = recorder(fixture);
    expect(await runStopCommand(["stopped"], deps, () => undefined)).toBe(
      false
    );
    expect(await runStopCommand(["-p", "stop"], deps, () => undefined)).toBe(
      false
    );
    expect(events).toEqual([]);
  });
});

// --- The default teardown keeps the shared-process rule ---------------------------

test("the default stop teardown never signals an app-server another live run records", async () => {
  await withRun({}, async (fixture) => {
    const original = { ...runProcessCleanupInternals.deps };
    const signalled: number[] = [];
    try {
      runProcessCleanupInternals.deps.commandForPid = (pid) =>
        pid === APP_SERVER
          ? "codex app-server --listen ws://127.0.0.1:45123"
          : undefined;
      runProcessCleanupInternals.deps.listeningPids = () => [APP_SERVER];
      runProcessCleanupInternals.deps.ownProcessGroup = () => 999;
      runProcessCleanupInternals.deps.processTable = () => [
        {
          pgid: APP_SERVER,
          pid: APP_SERVER,
          ppid: 1,
          startedAtMs: Date.parse(UPDATED_AT) - 60_000,
        },
      ];
      runProcessCleanupInternals.deps.commandTable = () => new Map();
      runProcessCleanupInternals.deps.otherRunIndex = () => ({
        kind: "read",
        references: [
          {
            pid: APP_SERVER,
            reference: UPDATED_AT,
            runDir: "/elsewhere/runs/repo-2/7",
            runId: "7",
            source: "codexAppServerPid",
          },
        ],
        runs: [],
      });
      runProcessCleanupInternals.deps.signal = (pid) => {
        signalled.push(pid);
      };
      const { deps } = recorder(fixture);
      const report = await stopRun(["1", "--yes"], {
        ...deps,
        cleanupRunProcesses: defaultRunStopDeps().cleanupRunProcesses,
      });
      expect(signalled).toEqual([]);
      expect(report?.skipped).toContainEqual(
        expect.objectContaining({
          otherRunId: "7",
          pid: APP_SERVER,
          reason: "shared-process-skipped",
        })
      );
    } finally {
      Object.assign(runProcessCleanupInternals.deps, original);
    }
  });
});

// --- The default session kill, on a real private tmux server ---------------------

const tmuxBinary = which("tmux");

test.skipIf(!tmuxBinary)(
  "real: the default session kill ends exactly the run's session on its recorded socket",
  async () => {
    const base = process.env.LOOP_TEST_HERMETIC_ENV ?? tmpdir();
    const dir = mkdtempSync(join(base, "st-"));
    const socket = join(dir, "s");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["TMUX", "TMUX_PANE"].includes(name)
      )
    );
    const tmux = (args: string[]) =>
      spawnSync([tmuxBinary as string, "-S", socket, ...args], {
        env,
        stderr: "pipe",
        stdout: "pipe",
      });
    const sessions = () =>
      new TextDecoder()
        .decode(tmux(["list-sessions", "-F", "#{session_name}"]).stdout)
        .split("\n")
        .filter(Boolean)
        .sort();
    try {
      for (const name of ["stop-loop-1", "stop-loop-10"]) {
        expect(
          tmux([
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            "80",
            "-y",
            "24",
            "sleep 120",
          ]).exitCode
        ).toBe(0);
      }
      await withRun(
        { tmuxSession: "stop-loop-1", tmuxSocket: socket },
        (fixture) => {
          const kill = defaultRunStopDeps().killSession;
          expect(kill(fixture.manifestPath, "stop-loop-1")).toEqual({
            kind: "killed",
          });
          expect(sessions()).toEqual(["stop-loop-10"]);
          // Gone now: tmux would resolve "stop-loop-1" to "stop-loop-10" by
          // prefix, so the kill must find no exact session and touch nothing.
          expect(kill(fixture.manifestPath, "stop-loop-1")).toEqual({
            kind: "absent",
          });
          expect(sessions()).toEqual(["stop-loop-10"]);
          return Promise.resolve();
        }
      );
    } finally {
      tmux(["kill-server"]);
      rmSync(dir, { force: true, recursive: true });
    }
  }
);

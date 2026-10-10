// The governess runs in a pane of the session its teardown kills, so the kill
// hangs it up. These tests pin how long it survives that hangup: until its
// teardown settles (the workspace release attempt is done), bounded by a
// grace window, and never past it. No tmux server is started; the last test
// sends a real SIGHUP to a child process that arms the real handler.

import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  armTeardownHangupGrace,
  defaultGovernessDeps,
  type GovernessConfig,
  settleTeardownHangupGrace,
  stopGovernessLoop,
  teardownHangupInternals,
} from "../../src/loop/governess";

const originalHooks = { ...teardownHangupInternals };

interface Harness {
  events: string[];
  /** Delivers the hangup the session kill would send. */
  hangup: () => void;
  /** Runs the pending grace timer, if one was scheduled. */
  runGraceTimer: () => void;
  scheduled: number[];
}

const harness = (): Harness => {
  const events: string[] = [];
  const scheduled: number[] = [];
  let handler: (() => void) | undefined;
  let timer: (() => void) | undefined;
  teardownHangupInternals.state = {
    armed: false,
    hungUp: false,
    settled: false,
  };
  teardownHangupInternals.graceMs = 10_000;
  teardownHangupInternals.exit = (code) => {
    events.push(`exit:${code}`);
  };
  teardownHangupInternals.onHangup = (registered) => {
    events.push("handler-registered");
    handler = registered;
  };
  teardownHangupInternals.schedule = (callback, ms) => {
    scheduled.push(ms);
    timer = callback;
  };
  return {
    events,
    hangup: () => {
      events.push("SIGHUP");
      handler?.();
    },
    runGraceTimer: () => {
      events.push("grace-expired");
      timer?.();
    },
    scheduled,
  };
};

afterEach(() => {
  Object.assign(teardownHangupInternals, originalHooks, {
    state: { armed: false, hungUp: false, settled: false },
  });
});

test("a hangup during the teardown is survived until the teardown settles, then exits at once", () => {
  const h = harness();
  armTeardownHangupGrace();
  h.hangup();
  expect(h.events).toEqual(["handler-registered", "SIGHUP"]);
  expect(h.scheduled).toEqual([10_000]);
  settleTeardownHangupGrace();
  expect(h.events).toEqual(["handler-registered", "SIGHUP", "exit:0"]);
});

test("a hangup whose teardown never settles exits when the grace runs out", () => {
  const h = harness();
  armTeardownHangupGrace();
  h.hangup();
  expect(h.events).not.toContain("exit:0");
  h.runGraceTimer();
  expect(h.events).toEqual([
    "handler-registered",
    "SIGHUP",
    "grace-expired",
    "exit:0",
  ]);
});

test("a hangup after the teardown settled exits at once, as an unarmed process would die", () => {
  const h = harness();
  armTeardownHangupGrace();
  settleTeardownHangupGrace();
  expect(h.events).toEqual(["handler-registered"]);
  h.hangup();
  expect(h.events).toEqual(["handler-registered", "SIGHUP", "exit:0"]);
  expect(h.scheduled).toEqual([]);
});

test("settling without arming does nothing, and arming registers one handler", () => {
  const h = harness();
  settleTeardownHangupGrace();
  expect(h.events).toEqual([]);
  armTeardownHangupGrace();
  armTeardownHangupGrace();
  expect(h.events).toEqual(["handler-registered"]);
  // The earlier unarmed settle did not count: this hangup is still survived.
  h.hangup();
  expect(h.events).toEqual(["handler-registered", "SIGHUP"]);
});

const teardownConfig = (dir: string): GovernessConfig =>
  ({
    agents: [],
    epoch: 1,
    logFile: join(dir, "governess.jsonl"),
    runDir: dir,
    runId: "70",
    session: "ai-cur-loop-70",
  }) as unknown as GovernessConfig;

test("the governess survives its own session kill until its release attempt is logged, on both teardown paths", async () => {
  for (const journal of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "loop-hangup-grace-"));
    try {
      const h = harness();
      const config = {
        ...teardownConfig(dir),
        journalTemporal: journal,
      } as unknown as GovernessConfig;
      await stopGovernessLoop(
        config,
        {
          ...defaultGovernessDeps(),
          appendLog: (_file, record) => {
            h.events.push((record as { event: string }).event);
          },
          cleanupRunProcesses: () => undefined,
          closeBeatWorkflow: journal
            ? () => Promise.resolve(undefined)
            : undefined,
          fenceCurrent: () => true,
          // What the default killSession does: arm, then kill the session
          // this process runs in, which hangs it up.
          killSession: () => {
            armTeardownHangupGrace();
            h.hangup();
          },
          markRunStopped: () => undefined,
          now: () => Date.parse("2026-10-06T11:00:00.000Z"),
          releaseWorkspaceAfterTeardown: async () => {
            await Promise.resolve();
            h.events.push("release-attempt");
            return { detail: "changed", released: true };
          },
        },
        "user requested teardown"
      );
      const name = journal ? "journal path" : "plain path";
      const tail = h.events.slice(h.events.indexOf("SIGHUP"));
      expect(tail, name).toEqual([
        "SIGHUP",
        "release-attempt",
        "workspace-released",
        "exit:0",
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a teardown whose kill fails settles the grace without a release attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-hangup-grace-"));
  try {
    const h = harness();
    await stopGovernessLoop(
      teardownConfig(dir),
      {
        ...defaultGovernessDeps(),
        appendLog: (_file, record) => {
          h.events.push((record as { event: string }).event);
        },
        cleanupRunProcesses: () => undefined,
        closeBeatWorkflow: undefined,
        fenceCurrent: () => true,
        killSession: () => {
          armTeardownHangupGrace();
          throw new Error("tmux control unavailable");
        },
        markRunStopped: () => undefined,
        now: () => Date.parse("2026-10-06T11:00:00.000Z"),
        releaseWorkspaceAfterTeardown: () => {
          h.events.push("release-attempt");
          return Promise.resolve({ detail: "changed", released: true });
        },
      },
      "user requested teardown"
    );
    expect(h.events).not.toContain("release-attempt");
    expect(teardownHangupInternals.state.settled).toBe(true);
    // A hangup that arrives late, from a kill that did land, exits at once.
    h.hangup();
    expect(h.events.at(-1)).toBe("exit:0");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A real SIGHUP against the real handler, in a child process: an unarmed
// process dies of the hangup; an armed one keeps running until it settles.
const GOVERNESS_MODULE = resolve(
  import.meta.dir,
  "../../src/loop/governess.ts"
);

const childScript = (arm: boolean): string => `
import { armTeardownHangupGrace, settleTeardownHangupGrace, teardownHangupInternals } from ${JSON.stringify(GOVERNESS_MODULE)};
teardownHangupInternals.graceMs = 20_000;
${arm ? "armTeardownHangupGrace();" : ""}
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("settle")) {
    process.stdout.write("settling\\n");
    settleTeardownHangupGrace();
  }
});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);
`;

const runChild = async (
  arm: boolean
): Promise<{
  aliveAfterHangup: boolean;
  code: number | null;
  signal: string | null;
  output: string;
}> => {
  const dir = mkdtempSync(join(tmpdir(), "loop-hangup-child-"));
  const script = join(dir, "child.ts");
  writeFileSync(script, childScript(arm));
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (done) => {
      child.on("exit", (code, signal) => done({ code, signal }));
    }
  );
  try {
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`child never ready: ${output}`)),
        30_000
      );
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("ready")) {
          clearTimeout(timer);
          ready();
        }
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
    });
    child.kill("SIGHUP");
    await new Promise((wait) => setTimeout(wait, 500));
    const aliveAfterHangup =
      child.exitCode === null && child.signalCode === null;
    if (aliveAfterHangup) {
      child.stdin.write("settle\n");
    }
    const result = await Promise.race([
      exited,
      new Promise<{ code: number | null; signal: string | null }>((done) =>
        setTimeout(() => done({ code: -1, signal: "still-running" }), 5000)
      ),
    ]);
    return { aliveAfterHangup, ...result, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(dir, { force: true, recursive: true });
  }
};

test("a real hangup kills an unarmed process at once but an armed one only when it settles", async () => {
  const unarmed = await runChild(false);
  expect(unarmed.aliveAfterHangup, unarmed.output).toBe(false);
  expect(unarmed.signal, unarmed.output).toBe("SIGHUP");

  const armed = await runChild(true);
  expect(armed.aliveAfterHangup, armed.output).toBe(true);
  expect(armed.output).toContain("settling");
  // Settling exits well inside the 20 s grace, with a clean status.
  expect({ code: armed.code, signal: armed.signal }, armed.output).toEqual({
    code: 0,
    signal: null,
  });
}, 60_000);

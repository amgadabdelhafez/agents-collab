import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleepSync } from "bun";
import {
  cleanupRunOwnedProcesses,
  gcAbandonedRunProcesses,
  registerRunBridgeProcess,
  registerRunOwnedProcess,
  runProcessCleanupInternals,
  unregisterRunBridgeProcess,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";
import { gcStaleBridgeProcesses } from "../../src/loop/stale-bridge-cleanup";

const makeRunDir = (): string =>
  mkdtempSync(join(tmpdir(), "loop-process-cleanup-"));

const fixturePidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const fixtureProcessValue = (pid: number, field: "command" | "lstart") => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`failed to inspect fixture PID ${pid}`);
  }
  return result.stdout.trim();
};

const fixtureProcessState = (pid: number): string | undefined => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
};

const stopFixturePid = (pid: number | undefined): void => {
  if (!(pid && fixturePidAlive(pid))) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100 && fixturePidAlive(pid); attempt += 1) {
    sleepSync(5);
  }
};

const waitForFixtureExit = async (
  child: ReturnType<typeof spawn>
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`fixture PID ${child.pid ?? "unknown"} did not exit`)),
      2000
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const readFixturePid = async (
  child: ReturnType<typeof spawn>
): Promise<number> => {
  if (!child.stdout) {
    throw new Error("fixture parent stdout unavailable");
  }
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    const line = output.split("\n")[0]?.trim();
    if (line) {
      const pid = Number.parseInt(line, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
      throw new Error(`invalid fixture child PID ${line}`);
    }
  }
  throw new Error("fixture parent exited before reporting child PID");
};

const spawnUnreapedTarget = async (): Promise<{
  parent: ReturnType<typeof spawn>;
  pid: number;
}> => {
  const parent = spawn(
    "python3",
    [
      "-c",
      [
        "import os, signal, time",
        "pid = os.fork()",
        "if pid == 0:",
        "    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))",
        "    while True:",
        "        signal.pause()",
        "print(pid, flush=True)",
        "time.sleep(30)",
      ].join("\n"),
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  return { parent, pid: await readFixturePid(parent) };
};

const stopUnreapedTarget = async (
  fixture: { parent: ReturnType<typeof spawn>; pid: number } | undefined
): Promise<void> => {
  if (!fixture) {
    return;
  }
  fixture.parent.kill("SIGKILL");
  await waitForFixtureExit(fixture.parent);
  for (
    let attempt = 0;
    attempt < 100 && fixturePidAlive(fixture.pid);
    attempt += 1
  ) {
    sleepSync(5);
  }
  stopFixturePid(fixture.pid);
};

const waitForFixtureState = (pid: number, expected: string): string => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = fixtureProcessState(pid);
    if (state?.startsWith(expected)) {
      return state;
    }
    sleepSync(5);
  }
  throw new Error(`fixture PID ${pid} did not reach state ${expected}`);
};

const writeOwnedRecord = (
  runDir: string,
  input: {
    agent?: "claude" | "codex";
    command: string;
    pid: number;
    role: "agent" | "launcher";
    startedAt: string;
  }
): string => {
  const registry = join(runDir, "run-processes");
  const path = join(
    registry,
    `owned-${input.role}${input.agent ? `-${input.agent}` : ""}-${input.pid}.json`
  );
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      ...(input.agent ? { agent: input.agent } : {}),
      command: input.command,
      kind: "run-owned",
      pid: input.pid,
      role: input.role,
      runDir,
      schemaVersion: 1,
      startedAt: input.startedAt,
    })}\n`,
    "utf8"
  );
  return path;
};

test("D15 teardown proves exact owned launcher and Claude PIDs absent while preserving an unowned process", async () => {
  const runDir = makeRunDir();
  const registry = join(runDir, "run-processes");
  const children = Array.from({ length: 3 }, () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
  );
  const [launcher, claude, unowned] = children.map((child) => child.pid);
  if (!(launcher && claude && unowned)) {
    throw new Error("fixture child PID unavailable");
  }
  try {
    mkdirSync(registry, { recursive: true });
    writeFileSync(
      join(registry, `owned-launcher-${launcher}.json`),
      `${JSON.stringify({
        command: fixtureProcessValue(launcher, "command"),
        kind: "run-owned",
        pid: launcher,
        role: "launcher",
        runDir,
        schemaVersion: 1,
        startedAt: fixtureProcessValue(launcher, "lstart"),
      })}\n`,
      "utf8"
    );
    writeFileSync(
      join(registry, `owned-agent-claude-${claude}.json`),
      `${JSON.stringify({
        agent: "claude",
        command: fixtureProcessValue(claude, "command"),
        kind: "run-owned",
        pid: claude,
        role: "agent",
        runDir,
        schemaVersion: 1,
        startedAt: fixtureProcessValue(claude, "lstart"),
      })}\n`,
      "utf8"
    );
    const manifest = createRunManifest({
      cwd: "/fixture/repo",
      mode: "paired",
      pid: launcher,
      repoId: "fixture-repo",
      runId: "15",
      tmuxSession: "fixture-owned-session",
    });

    const aliveBefore = [launcher, claude, unowned].map(fixturePidAlive);
    expect(aliveBefore).toEqual([true, true, true]);

    const result = cleanupRunOwnedProcesses(runDir, manifest);
    await Promise.all([
      waitForFixtureExit(children[0]),
      waitForFixtureExit(children[1]),
    ]);

    expect({
      aliveAfter: [launcher, claude, unowned].map(fixturePidAlive),
      aliveBefore,
      killed: result.killed.sort((left, right) => left - right),
    }).toEqual({
      aliveAfter: [false, false, true],
      aliveBefore: [true, true, true],
      killed: [launcher, claude].sort((left, right) => left - right),
    });
  } finally {
    for (const pid of [launcher, claude, unowned]) {
      stopFixturePid(pid);
    }
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 zombie target is settled after TERM while its parent has not reaped it", async () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let fixture: Awaited<ReturnType<typeof spawnUnreapedTarget>> | undefined;
  try {
    fixture = await spawnUnreapedTarget();
    const command = fixtureProcessValue(fixture.pid, "command");
    const startedAt = fixtureProcessValue(fixture.pid, "lstart");
    writeOwnedRecord(runDir, {
      agent: "claude",
      command,
      pid: fixture.pid,
      role: "agent",
      startedAt,
    });
    runProcessCleanupInternals.deps.signal = (pid, signal) => {
      signals.push({ pid, signal });
      process.kill(pid, signal);
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);
    const state = waitForFixtureState(fixture.pid, "Z");
    const psProbe = spawnSync("ps", ["-p", String(fixture.pid)], {
      encoding: "utf8",
    });

    expect(fixturePidAlive(fixture.pid)).toBe(true);
    expect(psProbe.status).toBe(0);
    expect(state.startsWith("Z")).toBe(true);
    expect(result).toEqual({
      killed: [fixture.pid],
      skipped: [],
    });
    expect(signals).toEqual([{ pid: fixture.pid, signal: "SIGTERM" }]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    await stopUnreapedTarget(fixture);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 TERM-resistant target receives KILL and settles in signal order", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7510;
  let state = "S";
  const signals: NodeJS.Signals[] = [];
  const path = writeOwnedRecord(runDir, {
    agent: "claude",
    command: "claude resistant target",
    pid,
    role: "agent",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "claude resistant target";
    runProcessCleanupInternals.deps.currentPid = () => 7599;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = () => state;
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        state = "Z";
      }
    };

    expect(cleanupRunOwnedProcesses(runDir, undefined)).toEqual({
      killed: [pid],
      skipped: [],
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(path)).toBe(false);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 post-TERM identity loss remains unresolved without KILL", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7520;
  let identityAvailable = true;
  const signals: NodeJS.Signals[] = [];
  const path = writeOwnedRecord(runDir, {
    command: "loop identity target",
    pid,
    role: "launcher",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      identityAvailable ? "loop identity target" : undefined;
    runProcessCleanupInternals.deps.currentPid = () => 7599;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      identityAvailable ? "Sat Aug 15 12:00:00 2026" : undefined;
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
      identityAvailable = false;
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result).toEqual({
      killed: [],
      skipped: [{ pid, reason: "post-term-identity-unavailable" }],
      unresolved: [{ pid, reason: "post-term-identity-unavailable" }],
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(existsSync(path)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(runDir, "run-processes", "unresolved-cleanup.json"),
          "utf8"
        )
      )
    ).toMatchObject({ unresolved: result.unresolved });
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 post-TERM PID identity change prevents KILL of the replacement", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7525;
  const recordedStart = "Sat Aug 15 12:00:00 2026";
  let observedStart = recordedStart;
  const signals: NodeJS.Signals[] = [];
  const path = writeOwnedRecord(runDir, {
    agent: "claude",
    command: "claude identity target",
    pid,
    role: "agent",
    startedAt: recordedStart,
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "claude identity target";
    runProcessCleanupInternals.deps.currentPid = () => 7599;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () => observedStart;
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
      observedStart = "Sat Aug 15 12:00:01 2026";
    };

    expect(cleanupRunOwnedProcesses(runDir, undefined)).toEqual({
      killed: [pid],
      skipped: [],
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(existsSync(path)).toBe(false);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 KILL failure retains ownership and unresolved retry evidence", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7530;
  const signals: NodeJS.Signals[] = [];
  const path = writeOwnedRecord(runDir, {
    agent: "codex",
    command: "codex resistant target",
    pid,
    role: "agent",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "codex resistant target";
    runProcessCleanupInternals.deps.currentPid = () => 7599;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        const error = new Error(
          "operation not permitted"
        ) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result).toEqual({
      killed: [],
      skipped: [{ pid, reason: "kill-failed:EPERM" }],
      unresolved: [{ pid, reason: "kill-failed:EPERM" }],
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(path)).toBe(true);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 post-KILL liveness uncertainty retains ownership evidence", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7540;
  let killSent = false;
  const signals: NodeJS.Signals[] = [];
  const path = writeOwnedRecord(runDir, {
    command: "loop uncertain target",
    pid,
    role: "launcher",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "loop uncertain target";
    runProcessCleanupInternals.deps.currentPid = () => 7599;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = () =>
      killSent ? undefined : "S";
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        killSent = true;
      }
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result).toEqual({
      killed: [],
      skipped: [{ pid, reason: "post-kill-unknown" }],
      unresolved: [{ pid, reason: "post-kill-unknown" }],
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(path)).toBe(true);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 cleanup never signals itself or an ancestor", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const selfPath = writeOwnedRecord(runDir, {
    agent: "codex",
    command: "codex app-server",
    pid: 7500,
    role: "agent",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  const ancestorPath = writeOwnedRecord(runDir, {
    command: "loop launcher",
    pid: 7300,
    role: "launcher",
    startedAt: "Sat Aug 15 11:59:59 2026",
  });
  const signals: number[] = [];
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 7500 ? "codex app-server" : "loop launcher";
    runProcessCleanupInternals.deps.currentPid = () => 7500;
    runProcessCleanupInternals.deps.parentPidFor = (pid) =>
      new Map([
        [7500, 7400],
        [7400, 7300],
        [7300, 1],
      ]).get(pid);
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.startForPid = (pid) =>
      pid === 7500 ? "Sat Aug 15 12:00:00 2026" : "Sat Aug 15 11:59:59 2026";
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = (pid) => signals.push(pid);

    const result = cleanupRunOwnedProcesses(runDir, undefined);
    const unresolved = JSON.parse(
      readFileSync(
        join(runDir, "run-processes", "unresolved-cleanup.json"),
        "utf8"
      )
    );

    expect(signals).toEqual([]);
    expect(
      [...(result.unresolved ?? [])].sort((left, right) => left.pid - right.pid)
    ).toEqual([
      { pid: 7300, reason: "self-or-ancestor" },
      { pid: 7500, reason: "self-or-ancestor" },
    ]);
    expect(existsSync(selfPath)).toBe(true);
    expect(existsSync(ancestorPath)).toBe(true);
    expect(unresolved).toMatchObject({
      kind: "run-cleanup-unresolved",
      unresolved: result.unresolved,
    });
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 failed self-launcher receipt retains active ownership and unresolved evidence", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  try {
    runProcessCleanupInternals.deps.commandForPid = () => "loop launcher";
    runProcessCleanupInternals.deps.currentPid = () => 7550;
    runProcessCleanupInternals.deps.now = () => "2026-08-15T12:00:00.000Z";
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = () => {
      throw new Error("self launcher must not be signaled");
    };
    const activePath = registerRunOwnedProcess(runDir, {
      pid: 7550,
      role: "launcher",
    });
    const receiptPath = join(
      runDir,
      "run-processes",
      "deferred-launcher-7550.json"
    );
    mkdirSync(receiptPath);

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result.deferred).toBeUndefined();
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved?.[0]).toEqual({
      pid: 7550,
      reason: expect.stringMatching(/^deferred-receipt-failed:/),
    });
    expect(existsSync(activePath)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(runDir, "run-processes", "unresolved-cleanup.json"),
          "utf8"
        )
      )
    ).toMatchObject({ unresolved: result.unresolved });
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 registration failures persist exact reasons until each PID settles", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const commandMissingPid = 7560;
  const startMissingPid = 7561;
  const states = new Map<number, string>([
    [commandMissingPid, "S"],
    [startMissingPid, "S"],
  ]);
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === commandMissingPid ? undefined : "claude registration target";
    runProcessCleanupInternals.deps.now = () => "2026-08-15T12:00:00.000Z";
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.startForPid = (pid) =>
      pid === startMissingPid ? undefined : "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = (pid) => states.get(pid);
    const commandFailurePath = registerRunOwnedProcess(runDir, {
      agent: "codex",
      pid: commandMissingPid,
      role: "agent",
    });
    const startFailurePath = registerRunOwnedProcess(runDir, {
      agent: "claude",
      pid: startMissingPid,
      role: "agent",
    });

    expect(commandFailurePath).toBe(
      join(
        runDir,
        "run-processes",
        `registration-failure-agent-codex-${commandMissingPid}.json`
      )
    );
    expect(startFailurePath).toBe(
      join(
        runDir,
        "run-processes",
        `registration-failure-agent-claude-${startMissingPid}.json`
      )
    );
    expect(JSON.parse(readFileSync(commandFailurePath, "utf8"))).toEqual({
      agent: "codex",
      kind: "run-owned-registration-failure",
      pid: commandMissingPid,
      reason: "process-command-unavailable",
      recordedAt: "2026-08-15T12:00:00.000Z",
      role: "agent",
      runDir,
      schemaVersion: 1,
    });
    expect(JSON.parse(readFileSync(startFailurePath, "utf8"))).toMatchObject({
      agent: "claude",
      pid: startMissingPid,
      reason: "process-start-unavailable",
    });

    const unresolved = cleanupRunOwnedProcesses(runDir, undefined);
    expect({
      ...unresolved,
      skipped: [...unresolved.skipped].sort(
        (left, right) => left.pid - right.pid
      ),
      unresolved: [...(unresolved.unresolved ?? [])].sort(
        (left, right) => left.pid - right.pid
      ),
    }).toEqual({
      killed: [],
      skipped: [
        {
          pid: commandMissingPid,
          reason: "registration-failure:process-command-unavailable",
        },
        {
          pid: startMissingPid,
          reason: "registration-failure:process-start-unavailable",
        },
      ],
      unresolved: [
        {
          pid: commandMissingPid,
          reason: "registration-failure:process-command-unavailable",
        },
        {
          pid: startMissingPid,
          reason: "registration-failure:process-start-unavailable",
        },
      ],
    });
    expect(existsSync(commandFailurePath)).toBe(true);
    expect(existsSync(startFailurePath)).toBe(true);

    states.set(commandMissingPid, "Z");
    states.set(startMissingPid, "Z");
    expect(cleanupRunOwnedProcesses(runDir, undefined)).toEqual({
      killed: [],
      skipped: [],
    });
    expect(existsSync(commandFailurePath)).toBe(false);
    expect(existsSync(startFailurePath)).toBe(false);
    expect(
      existsSync(join(runDir, "run-processes", "unresolved-cleanup.json"))
    ).toBe(false);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 launcher settlement matches exact command and one-second lstart", () => {
  const runDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const recordedStart = "Sat Aug 15 12:00:00 2026";
  const changedStart = "Sat Aug 15 12:00:01 2026";
  const states = new Map<number, string>([
    [7601, "S"],
    [7602, "S"],
  ]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  writeOwnedRecord(runDir, {
    command: "loop paired launcher",
    pid: 7601,
    role: "launcher",
    startedAt: recordedStart,
  });
  writeOwnedRecord(runDir, {
    command: "loop paired launcher",
    pid: 7602,
    role: "launcher",
    startedAt: recordedStart,
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "loop paired launcher";
    runProcessCleanupInternals.deps.currentPid = () => 7999;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = (pid) =>
      pid === 7601 ? recordedStart : changedStart;
    runProcessCleanupInternals.deps.stateForPid = (pid) => states.get(pid);
    runProcessCleanupInternals.deps.signal = (pid, signal) => {
      signals.push({ pid, signal });
      states.set(pid, "Z");
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result).toEqual({
      killed: [7601],
      skipped: [{ pid: 7602, reason: "owned-process-identity-mismatch" }],
    });
    expect(signals).toEqual([{ pid: 7601, signal: "SIGTERM" }]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 enumeration stays inside the fixture runDir and never touches live runs", () => {
  const runDir = makeRunDir();
  const liveRunDir = makeRunDir();
  const original = { ...runProcessCleanupInternals.deps };
  const states = new Map([[7701, "S"]]);
  const inspected: number[] = [];
  const signals: number[] = [];
  writeOwnedRecord(runDir, {
    command: "fixture target",
    pid: 7701,
    role: "launcher",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  const livePath = writeOwnedRecord(liveRunDir, {
    command: "preserved live target",
    pid: 7702,
    role: "launcher",
    startedAt: "Sat Aug 15 12:00:00 2026",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) => {
      inspected.push(pid);
      if (pid !== 7701) {
        throw new Error(`preserved PID ${pid} inspected`);
      }
      return "fixture target";
    };
    runProcessCleanupInternals.deps.currentPid = () => 7799;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = (pid) => {
      if (pid !== 7701) {
        throw new Error(`preserved PID ${pid} start inspected`);
      }
      return "Sat Aug 15 12:00:00 2026";
    };
    runProcessCleanupInternals.deps.stateForPid = (pid) => {
      if (pid !== 7701) {
        throw new Error(`preserved PID ${pid} state inspected`);
      }
      return states.get(pid);
    };
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
      states.set(pid, "Z");
    };

    expect(cleanupRunOwnedProcesses(runDir, undefined)).toEqual({
      killed: [7701],
      skipped: [],
    });
    expect(inspected).toEqual([7701, 7701]);
    expect(signals).toEqual([7701]);
    expect(existsSync(livePath)).toBe(true);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
    rmSync(liveRunDir, { force: true, recursive: true });
  }
});

test("D15 abandoned-run GC treats a zombie manifest launcher as settled", async () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-d15-zombie";
  const runDir = join(storageRoot, repoId, "15");
  const registry = join(runDir, "run-processes");
  let fixture: Awaited<ReturnType<typeof spawnUnreapedTarget>> | undefined;
  try {
    fixture = await spawnUnreapedTarget();
    const command = fixtureProcessValue(fixture.pid, "command");
    const startedAt = fixtureProcessValue(fixture.pid, "lstart");
    process.kill(fixture.pid, "SIGTERM");
    const state = waitForFixtureState(fixture.pid, "Z");
    mkdirSync(registry, { recursive: true });
    writeRunManifest(
      join(runDir, "manifest.json"),
      createRunManifest({
        cwd: "/fixture/repo",
        mode: "paired",
        pid: fixture.pid,
        repoId,
        runId: "15",
        state: "stopped",
      })
    );
    const receipt = join(registry, `deferred-launcher-${fixture.pid}.json`);
    writeFileSync(
      receipt,
      `${JSON.stringify({
        command,
        deferredAt: "2026-08-15T12:00:00.000Z",
        kind: "run-owned-deferred-launcher",
        pid: fixture.pid,
        role: "launcher",
        runDir,
        schemaVersion: 1,
        startedAt,
      })}\n`,
      "utf8"
    );
    const psProbe = spawnSync("ps", ["-p", String(fixture.pid)], {
      encoding: "utf8",
    });

    expect(fixturePidAlive(fixture.pid)).toBe(true);
    expect(psProbe.status).toBe(0);
    expect(state.startsWith("Z")).toBe(true);
    expect(
      gcAbandonedRunProcesses({
        deps: {
          listTmuxSessions: () => new Set(),
          signal: () => {
            throw new Error("zombie launcher must not be signaled");
          },
        },
        log: () => undefined,
        repoId,
        storageRoot,
      })
    ).toEqual({
      cleaned: 1,
      kept: 0,
      killed: [],
      scanned: 1,
      skipped: [],
    });
    expect(existsSync(receipt)).toBe(false);
  } finally {
    await stopUnreapedTarget(fixture);
    rmSync(root, { force: true, recursive: true });
  }
});

test("teardown signals only bridge processes registered to the exact run", () => {
  const runDir = makeRunDir();
  const otherRun = `${runDir}-other`;
  const signals: number[] = [];
  const original = { ...runProcessCleanupInternals.deps };
  const matching = registerRunBridgeProcess(runDir, "claude", 4101);
  registerRunBridgeProcess(runDir, "codex", 4102);
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 4101
        ? `loop __bridge-mcp ${runDir} claude`
        : `loop __bridge-mcp ${otherRun} codex`;
    runProcessCleanupInternals.deps.listeningPids = () => [];
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };

    const result = cleanupRunOwnedProcesses(runDir, undefined);

    expect(result.killed).toEqual([4101]);
    expect(result.skipped).toEqual([
      { pid: 4102, reason: "bridge-command-mismatch" },
    ]);
    expect(signals).toEqual([4101]);
  } finally {
    unregisterRunBridgeProcess(matching);
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("teardown requires both app-server command and owned listener port", () => {
  const runDir = makeRunDir();
  const signals: number[] = [];
  const original = { ...runProcessCleanupInternals.deps };
  const manifest = createRunManifest({
    codexAppServerPid: 4501,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    cwd: "/repo",
    mode: "paired",
    pid: 100,
    repoId: "repo-1",
    runId: "1",
  });
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://";
    runProcessCleanupInternals.deps.listeningPids = () => [44_149];
    runProcessCleanupInternals.deps.signal = (pid) => {
      signals.push(pid);
    };

    const protectedResult = cleanupRunOwnedProcesses(runDir, manifest);
    expect(protectedResult.killed).toEqual([]);
    expect(protectedResult.skipped).toEqual([
      { pid: 4501, reason: "app-server-identity-mismatch" },
    ]);

    runProcessCleanupInternals.deps.listeningPids = () => [4501];
    const ownedResult = cleanupRunOwnedProcesses(runDir, manifest);
    expect(ownedResult.killed).toEqual([4501]);
    expect(signals).toEqual([4501]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("startup GC reaps only provably abandoned runs in the current repository", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const repoRuns = join(storageRoot, repoId);
  const signals: number[] = [];
  const logs: string[] = [];
  let tmuxListCalls = 0;
  const manifestFor = (
    runId: string,
    pid: number,
    overrides: Parameters<typeof createRunManifest>[0] = {
      cwd: "/repo",
      mode: "paired",
      pid,
      repoId,
      runId,
    }
  ) =>
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid,
      repoId,
      runId,
      ...overrides,
    });
  const write = (runId: string, manifest: ReturnType<typeof manifestFor>) => {
    const runDir = join(repoRuns, runId);
    mkdirSync(runDir, { recursive: true });
    writeRunManifest(join(runDir, "manifest.json"), manifest);
    return runDir;
  };
  const abandonedDir = write(
    "88",
    manifestFor("88", 8800, {
      codexAppServerPid: 8801,
      codexRemoteUrl: "ws://127.0.0.1:4500",
      cwd: "/repo",
      mode: "paired",
      pid: 8800,
      repoId,
      runId: "88",
      state: "submitted",
      tmuxSession: "abandoned-loop",
    })
  );
  const abandonedBridge = registerRunBridgeProcess(
    abandonedDir,
    "claude",
    8802
  );
  write(
    "87",
    manifestFor("87", 8700, {
      cwd: "/repo",
      mode: "paired",
      pid: 8700,
      repoId,
      runId: "87",
      state: "completed",
    })
  );
  const liveLauncherDir = write("89", manifestFor("89", 8900));
  registerRunBridgeProcess(liveLauncherDir, "claude", 8902);
  const unknownTmuxDir = write(
    "90",
    manifestFor("90", 9000, {
      cwd: "/repo",
      mode: "paired",
      pid: 9000,
      repoId,
      runId: "90",
      tmuxSession: "unknown-loop",
    })
  );
  registerRunBridgeProcess(unknownTmuxDir, "claude", 9002);
  const liveTmuxDir = write(
    "98",
    manifestFor("98", 9800, {
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  const liveBridge = registerRunBridgeProcess(liveTmuxDir, "claude", 9802);
  const malformedDir = join(repoRuns, "bad");
  mkdirSync(malformedDir, { recursive: true });
  writeFileSync(join(malformedDir, "manifest.json"), "{}\n", "utf8");
  write("91", manifestFor("92", 9100));
  const otherRepoDir = join(storageRoot, "repo-other", "1");
  mkdirSync(otherRepoDir, { recursive: true });
  writeRunManifest(
    join(otherRepoDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 1111,
      codexRemoteUrl: "ws://127.0.0.1:4511",
      cwd: "/other",
      mode: "paired",
      pid: 1110,
      repoId: "repo-other",
      runId: "1",
    })
  );

  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          if (pid === 8801) {
            return "codex app-server --listen ws://127.0.0.1:4500";
          }
          if (pid === 8802) {
            return `loop __bridge-mcp ${abandonedDir} claude`;
          }
          throw new Error(`must not inspect process ${pid}`);
        },
        listTmuxSessions: () => {
          tmuxListCalls += 1;
          return new Set(["unknown-loop", "harvto-loop-98"]);
        },
        listeningPids: (port) => (port === 4500 ? [8801] : []),
        pidAlive: (pid) => {
          if (pid === 8700) {
            throw new Error(
              "settled runs without ownership need no liveness probe"
            );
          }
          return pid === 8900;
        },
        signal: (pid) => {
          signals.push(pid);
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toEqual({
      cleaned: 1,
      kept: 6,
      killed: [8802, 8801],
      scanned: 5,
      skipped: [],
    });
    expect(tmuxListCalls).toBe(1);
    expect(signals).toEqual([8802, 8801]);
    expect(logs).toEqual([
      '[loop] cleaned 1 abandoned run for "repo-current" (2 processes signaled)',
    ]);
    const abandonedManifest = readRunManifest(
      join(abandonedDir, "manifest.json")
    );
    expect(abandonedManifest).toMatchObject({
      state: "failed",
      status: "failed",
    });
    expect(abandonedManifest?.codexAppServerPid).toBeUndefined();
    expect(abandonedManifest?.codexRemoteUrl).toBeUndefined();
    expect(existsSync(abandonedBridge)).toBe(false);
    expect(existsSync(liveBridge)).toBe(true);
    expect(readRunManifest(join(liveTmuxDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      status: "running",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC preserves an active detached run with missing tmux ownership", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "101");
  const manifestPath = join(runDir, "manifest.json");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexAppServerPid: 4419,
      codexRemoteUrl: "ws://127.0.0.1:4500",
      cwd: "/repo",
      mode: "paired",
      pid: 4405,
      repoId,
      runId: "101",
      state: "working",
      tmuxPaneLeft: "%0",
      tmuxPaneRight: "%1",
    })
  );
  const bridgeRecord = registerRunBridgeProcess(runDir, "claude", 4591);
  const before = readFileSync(manifestPath, "utf8");
  const signals: number[] = [];

  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          throw new Error(`active run process ${pid} must not be inspected`);
        },
        listTmuxSessions: () => new Set(),
        listeningPids: () => {
          throw new Error("active run listener must not be inspected");
        },
        pidAlive: () => false,
        signal: (pid) => signals.push(pid),
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });

    expect(result).toEqual({
      cleaned: 0,
      kept: 1,
      killed: [],
      scanned: 1,
      skipped: [],
    });
    expect(signals).toEqual([]);
    expect(existsSync(bridgeRecord)).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(readRunManifest(manifestPath)).toMatchObject({
      codexAppServerPid: 4419,
      state: "working",
      status: "running",
      tmuxPaneLeft: "%0",
      tmuxPaneRight: "%1",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC never signals stale-run processes that fail ownership proof", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "92");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 9201,
      codexRemoteUrl: "ws://127.0.0.1:4520",
      cwd: "/repo",
      mode: "paired",
      pid: 9200,
      repoId,
      runId: "92",
      tmuxSession: "repo-loop-92",
    })
  );
  registerRunBridgeProcess(runDir, "claude", 9202);
  const signals: number[] = [];
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) =>
          pid === 9202
            ? "loop __bridge-mcp /another/run claude"
            : "codex app-server --listen ws://127.0.0.1:4520",
        listTmuxSessions: () => new Set(),
        listeningPids: () => [],
        pidAlive: () => false,
        signal: (pid) => signals.push(pid),
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result).toMatchObject({ cleaned: 1, killed: [] });
    expect(result.skipped).toEqual([
      { pid: 9202, reason: "bridge-command-mismatch" },
      { pid: 9201, reason: "app-server-identity-mismatch" },
    ]);
    expect(signals).toEqual([]);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "failed",
      status: "failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC preserves a run present in the bounded tmux snapshot", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "98");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      codexAppServerPid: 9801,
      codexRemoteUrl: "ws://127.0.0.1:4598",
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  const bridgeRecord = registerRunBridgeProcess(runDir, "claude", 9802);
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: (pid) => {
          throw new Error(`live run process ${pid} must not be inspected`);
        },
        listTmuxSessions: () => new Set(["harvto-loop-98"]),
        listeningPids: () => {
          throw new Error("live run listener must not be inspected");
        },
        pidAlive: () => false,
        signal: () => {
          throw new Error("live run must not be signaled");
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(result).toEqual({
      cleaned: 0,
      kept: 1,
      killed: [],
      scanned: 1,
      skipped: [],
    });
    expect(existsSync(bridgeRecord)).toBe(true);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      status: "running",
      tmuxSession: "harvto-loop-98",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC retains app-server ownership evidence after a signal failure", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "93");
  const manifestPath = join(runDir, "manifest.json");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      cwd: "/repo",
      mode: "paired",
      pid: 9300,
      repoId,
      runId: "93",
      tmuxSession: "repo-loop-93",
    })
  );
  const commonDeps = {
    commandForPid: () => "codex app-server --listen ws://127.0.0.1:4530",
    listTmuxSessions: () => new Set<string>(),
    listeningPids: () => [9301],
    pidAlive: () => false,
  };
  try {
    const failed = gcAbandonedRunProcesses({
      deps: {
        ...commonDeps,
        signal: () => {
          const error = new Error(
            "operation not permitted"
          ) as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(failed).toMatchObject({
      cleaned: 1,
      killed: [],
      skipped: [{ pid: 9301, reason: "signal-failed:EPERM" }],
    });
    expect(readRunManifest(manifestPath)).toMatchObject({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      state: "failed",
    });

    const retriedSignals: number[] = [];
    const retried = gcAbandonedRunProcesses({
      deps: {
        ...commonDeps,
        signal: (pid) => retriedSignals.push(pid),
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });
    expect(retried).toMatchObject({ cleaned: 1, killed: [9301], skipped: [] });
    expect(retriedSignals).toEqual([9301]);
    expect(readRunManifest(manifestPath)?.codexAppServerPid).toBeUndefined();
    expect(readRunManifest(manifestPath)?.codexRemoteUrl).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC contains tmux snapshot failures and preserves tmux-owned runs", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "98");
  const logs: string[] = [];
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9800,
      repoId,
      runId: "98",
      tmuxSession: "harvto-loop-98",
    })
  );
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        listTmuxSessions: () => {
          throw new Error("tmux unavailable");
        },
        pidAlive: () => {
          throw new Error("unknown tmux liveness must preserve the run");
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({ cleaned: 0, kept: 1, scanned: 1 });
    expect(logs).toEqual([
      "[loop] abandoned-run cleanup could not inspect tmux; preserving tmux-owned runs: tmux unavailable",
    ]);
    expect(readRunManifest(join(runDir, "manifest.json"))).toMatchObject({
      state: "submitted",
      tmuxSession: "harvto-loop-98",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC contains manifest repair failures before signaling and continues", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const failedRunDir = join(storageRoot, repoId, "93");
  const nextRunDir = join(storageRoot, repoId, "94");
  const failedManifestPath = join(failedRunDir, "manifest.json");
  const nextManifestPath = join(nextRunDir, "manifest.json");
  const logs: string[] = [];
  const signals: number[] = [];
  mkdirSync(failedRunDir, { recursive: true });
  mkdirSync(nextRunDir, { recursive: true });
  writeRunManifest(
    failedManifestPath,
    createRunManifest({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      cwd: "/repo",
      mode: "paired",
      pid: 9300,
      repoId,
      runId: "93",
      tmuxSession: "repo-loop-93",
    })
  );
  writeRunManifest(
    nextManifestPath,
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9400,
      repoId,
      runId: "94",
      tmuxSession: "repo-loop-94",
    })
  );
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: () => "codex app-server --listen ws://127.0.0.1:4530",
        listTmuxSessions: () => new Set(),
        listeningPids: () => [9301],
        pidAlive: () => false,
        signal: (pid) => signals.push(pid),
        updateManifest: (manifestPath, update) => {
          if (manifestPath === failedManifestPath) {
            throw new Error("manifest is read-only");
          }
          return updateRunManifest(manifestPath, update);
        },
      },
      log: (line) => logs.push(line),
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({ cleaned: 1, kept: 1, scanned: 1 });
    expect(signals).toEqual([]);
    expect(logs).toEqual([
      '[loop] abandoned-run cleanup skipped run "93": manifest is read-only',
      '[loop] cleaned 1 abandoned run for "repo-current" (0 processes signaled)',
    ]);
    expect(readRunManifest(failedManifestPath)).toMatchObject({
      codexAppServerPid: 9301,
      codexRemoteUrl: "ws://127.0.0.1:4530",
      state: "submitted",
    });
    expect(readRunManifest(nextManifestPath)).toMatchObject({
      state: "failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("startup GC retains bridge registration after a signal failure", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const repoId = "repo-current";
  const runDir = join(storageRoot, repoId, "95");
  mkdirSync(runDir, { recursive: true });
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 9500,
      repoId,
      runId: "95",
      tmuxSession: "repo-loop-95",
    })
  );
  const bridgeRecord = registerRunBridgeProcess(runDir, "claude", 9502);
  try {
    const result = gcAbandonedRunProcesses({
      deps: {
        commandForPid: () => `loop __bridge-mcp ${runDir} claude`,
        listTmuxSessions: () => new Set(),
        pidAlive: () => false,
        signal: () => {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        },
      },
      log: () => undefined,
      repoId,
      storageRoot,
    });

    expect(result).toMatchObject({
      cleaned: 1,
      killed: [],
      skipped: [{ pid: 9502, reason: "signal-failed:EBUSY" }],
    });
    expect(existsSync(bridgeRecord)).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cross-repo sweep signals only exact bridges for terminal or absent runs", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const executable = "/opt/old-loop/loop";
  const terminalDir = join(storageRoot, "repo-one", "14");
  const absentDir = join(storageRoot, "repo-two", "1");
  const activeDir = join(storageRoot, "repo-three", "100");
  const unknownDir = join(storageRoot, "agent-channel", "1");
  const signals: number[] = [];
  const logs: string[] = [];
  mkdirSync(terminalDir, { recursive: true });
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(unknownDir, { recursive: true });
  writeRunManifest(
    join(terminalDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo-one",
      mode: "paired",
      pid: 1400,
      repoId: "repo-one",
      runId: "14",
      state: "stopped",
    })
  );
  writeRunManifest(
    join(activeDir, "manifest.json"),
    createRunManifest({
      cwd: "/repo-three",
      mode: "paired",
      pid: 1000,
      repoId: "repo-three",
      runId: "100",
      state: "submitted",
    })
  );
  writeFileSync(
    join(unknownDir, "manifest.json"),
    '{"repoId":"agent-channel","runId":"1","state":"submitted"}\n',
    "utf8"
  );
  const commands = new Map([
    [6101, `${executable} __bridge-mcp ${terminalDir} claude`],
    [6102, `${executable} __bridge-mcp ${absentDir} codex`],
    [6103, `${executable} __bridge-mcp ${activeDir} claude`],
    [6104, `${executable} __bridge-mcp ${unknownDir} codex`],
  ]);
  try {
    const result = gcStaleBridgeProcesses({
      deps: {
        commandForPid: (pid) => commands.get(pid),
        executableForPid: () => executable,
        listLoopProcesses: () =>
          [6101, 6102, 6103, 6104].map((pid) => ({
            executable,
            pid,
          })),
        signal: (pid) => signals.push(pid),
      },
      log: (line) => logs.push(line),
      storageRoot,
    });

    expect(result).toEqual({
      candidates: 4,
      killed: [6101, 6102],
      scanned: 4,
      skipped: [
        { pid: 6103, reason: "run-state-unknown-or-active" },
        { pid: 6104, reason: "run-state-unknown-or-active" },
      ],
    });
    expect(signals).toEqual([6101, 6102]);
    expect(logs).toEqual([
      "[loop] stale bridge sweep checked 4 candidates: 2 signaled, 2 preserved",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cross-repo sweep ignores parent commands with embedded bridge JSON", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const runDir = join(storageRoot, "repo-one", "14");
  const appServer = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const claude = "/Applications/Claude.app/Contents/MacOS/claude";
  const signals: number[] = [];
  const commands = new Map([
    [
      6201,
      `${appServer} -c mcp_servers.loop.args=["__bridge-mcp","${runDir}","codex"] app-server`,
    ],
    [
      6202,
      `${claude} --mcp-config {"args":["__bridge-mcp","${runDir}","claude"]}`,
    ],
  ]);
  try {
    const result = gcStaleBridgeProcesses({
      deps: {
        commandForPid: (pid) => commands.get(pid),
        executableForPid: (pid) => (pid === 6201 ? appServer : claude),
        listLoopProcesses: () => [
          { executable: appServer, pid: 6201 },
          { executable: claude, pid: 6202 },
        ],
        signal: (pid) => signals.push(pid),
      },
      log: () => undefined,
      storageRoot,
    });

    expect(result).toEqual({
      candidates: 0,
      killed: [],
      scanned: 2,
      skipped: [],
    });
    expect(signals).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cross-repo sweep rejects non-canonical commands and changed PID identity", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const executable = "/opt/old-loop/loop";
  const absentDir = join(storageRoot, "repo-one", "gone");
  const firstCommand = `${executable} __bridge-mcp ${absentDir} claude`;
  const commandReads = new Map<number, number>();
  const commands = new Map([
    [6301, firstCommand],
    [6302, `${firstCommand} --extra`],
    [6303, `${executable} __bridge-mcp ${storageRoot}/../outside/1 claude`],
    [6304, `${executable} __bridge-mcp ${absentDir} stranger`],
  ]);
  const signals: number[] = [];
  try {
    const result = gcStaleBridgeProcesses({
      deps: {
        commandForPid: (pid) => {
          const read = (commandReads.get(pid) ?? 0) + 1;
          commandReads.set(pid, read);
          if (pid === 6301 && read === 2) {
            return `${executable} dashboard`;
          }
          return commands.get(pid);
        },
        executableForPid: () => executable,
        listLoopProcesses: () =>
          [6301, 6302, 6303, 6304].map((pid) => ({
            executable,
            pid,
          })),
        signal: (pid) => signals.push(pid),
      },
      log: () => undefined,
      storageRoot,
    });

    expect(result).toEqual({
      candidates: 1,
      killed: [],
      scanned: 4,
      skipped: [{ pid: 6301, reason: "bridge-identity-changed" }],
    });
    expect(signals).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cross-repo sweep preserves a contradictory active terminal manifest", () => {
  const root = makeRunDir();
  const storageRoot = join(root, "runs");
  const executable = "/opt/old-loop/loop";
  const runDir = join(storageRoot, "repo-one", "14");
  const manifest = createRunManifest({
    cwd: "/repo-one",
    mode: "paired",
    pid: 1400,
    repoId: "repo-one",
    runId: "14",
    state: "stopped",
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, status: "running" })}\n`,
    "utf8"
  );
  try {
    const result = gcStaleBridgeProcesses({
      deps: {
        commandForPid: () => `${executable} __bridge-mcp ${runDir} claude`,
        executableForPid: () => executable,
        listLoopProcesses: () => [{ executable, pid: 6351 }],
        signal: () => {
          throw new Error("active evidence must preserve the process");
        },
      },
      log: () => undefined,
      storageRoot,
    });

    expect(result).toMatchObject({
      candidates: 1,
      killed: [],
      skipped: [{ pid: 6351, reason: "run-state-unknown-or-active" }],
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cross-repo sweep rechecks terminal state before its final PID check", () => {
  const storageRoot = join(makeRunDir(), "runs");
  const executable = "/opt/old-loop/loop";
  const runDir = join(storageRoot, "repo-one", "14");
  let stateReads = 0;
  try {
    const result = gcStaleBridgeProcesses({
      deps: {
        commandForPid: () => `${executable} __bridge-mcp ${runDir} claude`,
        executableForPid: () => executable,
        listLoopProcesses: () => [{ executable, pid: 6371 }],
        manifestIsTerminal: () => {
          stateReads += 1;
          return stateReads === 1;
        },
        runDirectoryKind: () => "directory",
        signal: () => {
          throw new Error("changed run state must preserve the process");
        },
      },
      log: () => undefined,
      storageRoot,
    });

    expect(result).toMatchObject({
      candidates: 1,
      killed: [],
      skipped: [{ pid: 6371, reason: "run-state-changed" }],
    });
    expect(stateReads).toBe(2);
  } finally {
    rmSync(join(storageRoot, ".."), { force: true, recursive: true });
  }
});

test("cross-repo sweep contains enumeration and per-process inspection failures", () => {
  const storageRoot = join(makeRunDir(), "runs");
  const executable = "/opt/old-loop/loop";
  const absentDir = join(storageRoot, "repo-one", "gone");
  const logs: string[] = [];
  const enumerationFailure = gcStaleBridgeProcesses({
    deps: { listLoopProcesses: () => undefined },
    log: (line) => logs.push(line),
    storageRoot,
  });
  expect(enumerationFailure).toEqual({
    candidates: 0,
    killed: [],
    scanned: 0,
    skipped: [],
  });
  expect(logs).toEqual([
    "[loop] stale bridge sweep could not inspect processes; preserving all",
  ]);

  const contained = gcStaleBridgeProcesses({
    deps: {
      commandForPid: () => `${executable} __bridge-mcp ${absentDir} claude`,
      executableForPid: () => executable,
      listLoopProcesses: () => [{ executable, pid: 6401 }],
      runDirectoryKind: () => {
        throw new Error("permission denied");
      },
      signal: () => {
        throw new Error("must preserve on inspection failure");
      },
    },
    log: () => undefined,
    storageRoot,
  });
  expect(contained).toEqual({
    candidates: 1,
    killed: [],
    scanned: 1,
    skipped: [{ pid: 6401, reason: "inspection-failed:permission denied" }],
  });
  rmSync(join(storageRoot, ".."), { force: true, recursive: true });
});

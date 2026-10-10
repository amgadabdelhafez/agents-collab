// The process groups of the agent CLIs' tool subprocesses (review of a4345e15).
//
// The real CLIs do not keep their tool subprocesses in the pane's process
// group: Claude Code starts each Bash tool shell as a session leader, and
// Codex starts each exec command and MCP server in a group of its own. These
// tests pin that the groups of every descendant of a recorded agent pane
// process are recorded from a process table snapshot (by a ppid walk while the
// CLI is still the parent), that a record is kept, replaced or pruned only on
// proof, that a termination target is re-identified right before every
// signal (so a group id reused after the record is never signalled), that the
// governess snapshots on its cycle, and, with real processes, that a tool
// subprocess in its own session survives the pane group's end, blocks the
// release, and is ended by the teardown's termination.
//
// No tmux server is started or contacted in this file. The "real" tests start
// their own detached sh / perl / sleep processes and end them.

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  type GovernessConfig,
  type GovernessDeps,
  governessTeardownInProgress,
  recordAgentDescendantGroupsOnCycle,
  stopGovernessLoop,
} from "../../src/loop/governess";
import {
  defaultPidOwnershipDeps,
  pidCanStillOwnRun,
} from "../../src/loop/pid-ownership";
import {
  defaultTerminationDeps,
  descendantsOf,
  groupCanStillOwnRun,
  type ProcessRow,
  parseProcessTable,
  processGroupAlive,
  readProcessTable,
  type TerminationDeps,
  targetStillRecorded,
  terminateTargets,
} from "../../src/loop/process-group";
import {
  readAgentGroupRecords,
  recordAgentDescendantGroups,
  recordRunPaneProcesses,
} from "../../src/loop/run-pane-processes";
import {
  AGENT_DESCENDANT_SNAPSHOT_INTERVAL_MS,
  collectRunAgentGroups,
  recordRunAgentDescendantsThrottled,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  type RunManifest,
  reconcileLegacyStoppedRun,
} from "../../src/loop/run-state";

const RECORDED_AT = "2026-10-05T21:00:00.000Z";
const SNAPSHOT_AT = "2026-10-06T12:00:00.000Z";
const at = (iso: string): number => Date.parse(iso);
const BEFORE = at(RECORDED_AT) - 60_000;
const AFTER = at(SNAPSHOT_AT) + 60_000;

const originalCleanupDeps = { ...runProcessCleanupInternals.deps };
afterEach(() => {
  Object.assign(runProcessCleanupInternals.deps, originalCleanupDeps);
});

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  startedAtMs: number | undefined = BEFORE
): ProcessRow => ({ pgid, pid, ppid, startedAtMs });

const withRunDir = (run: (runDir: string) => void | Promise<void>) => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-descendants-"));
  const done = async () => {
    try {
      await run(runDir);
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  };
  return done();
};

const writePane = (
  runDir: string,
  paneId: string,
  pid: number,
  pgid = pid,
  recordedAt = RECORDED_AT
) =>
  recordRunPaneProcesses({
    agentPaneIds: [paneId],
    now: () => recordedAt,
    panes: [{ paneId, pid }],
    pgidOf: () => pgid,
    runDir,
    session: "loop-91",
  });

const groupFiles = (runDir: string): string[] => {
  try {
    return readdirSync(join(runDir, "run-processes"))
      .filter((file) => file.startsWith("agent-group-"))
      .sort();
  } catch {
    return [];
  }
};

// --- The process table and the descendant walk -------------------------------

test("the process table parses ps rows, and the walk finds every descendant however deep", () => {
  const table = parseProcessTable(
    [
      "    1     0     1 Fri Oct  9 08:22:25 2026",
      "  501     1   501 Sat Oct 10 00:19:32 2026",
      "  601   501   601 Sat Oct 10 00:19:33 2026",
      "  602   601   601 Sat Oct 10 00:19:34 2026",
      "  603   602   603 Sat Oct 10 00:19:35 2026",
      "  900     1   900 Sat Oct 10 00:19:36 2026",
      "garbage line",
      "  777   1   777 not a date",
    ].join("\n")
  );
  expect(table.map((entry) => entry.pid)).toEqual([
    1, 501, 601, 602, 603, 900, 777,
  ]);
  expect(table[1]?.startedAtMs).toBe(Date.parse("Sat Oct 10 00:19:32 2026"));
  expect(table[6]?.startedAtMs).toBeUndefined();
  expect(descendantsOf([501], table).map((entry) => entry.pid)).toEqual([
    601, 602, 603,
  ]);
  expect(descendantsOf([900], table)).toEqual([]);
  // The real table of this machine holds this process under its parent.
  const real = readProcessTable();
  expect(real?.some((entry) => entry.pid === process.pid)).toBe(true);
  expect(
    descendantsOf([process.ppid], real ?? []).some(
      (entry) => entry.pid === process.pid
    )
  ).toBe(true);
});

// --- Recording ----------------------------------------------------------------

test("the groups of a pane CLI's descendants are recorded: own-session shells, per-command groups, nested ones", async () => {
  await withRunDir((runDir) => {
    writePane(runDir, "%1", 501);
    writePane(runDir, "%2", 502);
    const table = [
      row(501, 1, 501),
      // Claude: a Bash tool shell leads its own session and group, with a
      // build in it and a background server that made its own group too.
      row(601, 501, 601),
      row(602, 601, 601),
      row(603, 602, 603),
      // Claude MCP servers stay in the CLI's (pane's) group: not recorded
      // again, the pane record covers them.
      row(604, 501, 501),
      row(502, 1, 502),
      // Codex: every child leads its own group.
      row(701, 502, 701),
      row(702, 502, 702),
      // Unrelated, and this process's own group: never recorded.
      row(900, 1, 900),
      row(905, 502, 905),
    ];
    const result = recordAgentDescendantGroups({
      groupAlive: () => false,
      now: () => SNAPSHOT_AT,
      ownGroup: 905,
      runDir,
      table,
    });
    expect(result.records.map((record) => record.pgid).sort()).toEqual([
      601, 603, 701, 702,
    ]);
    expect(
      readAgentGroupRecords(runDir).map((record) => [
        record.pgid,
        record.paneId,
        record.recordedAt,
      ])
    ).toEqual([
      [601, "%1", SNAPSHOT_AT],
      [603, "%1", SNAPSHOT_AT],
      [701, "%2", SNAPSHOT_AT],
      [702, "%2", SNAPSHOT_AT],
    ]);
    expect(readdirSync(runDir).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
  });
});

test("a pane pid that now names another process is never walked", async () => {
  await withRunDir((runDir) => {
    writePane(runDir, "%1", 501);
    writePane(runDir, "%2", 502);
    recordAgentDescendantGroups({
      groupAlive: () => false,
      now: () => SNAPSHOT_AT,
      runDir,
      table: [
        // 501 was reused by a process started after the record.
        row(501, 1, 501, AFTER),
        row(601, 501, 601),
        // 502 is alive but no longer in the recorded group.
        row(502, 1, 333),
        row(701, 502, 701),
        // Start time unknown: not provably the recorded process.
        row(503, 1, 503, undefined),
      ],
    });
    expect(groupFiles(runDir)).toEqual([]);
  });
});

test("a record is kept and moved up for the same group, replaced for a reused id, and pruned only once the group is gone", async () => {
  await withRunDir((runDir) => {
    writePane(runDir, "%1", 501);
    const snapshot = (
      table: ProcessRow[],
      now: string,
      groupAlive: (pgid: number) => boolean = () => false
    ) =>
      recordAgentDescendantGroups({
        groupAlive,
        now: () => now,
        runDir,
        table,
      });
    const T3 = "2026-10-06T13:00:00.000Z";
    const T4 = "2026-10-06T14:00:00.000Z";
    const instant = () => readAgentGroupRecords(runDir)[0]?.recordedAt;
    const paneInstant = () =>
      JSON.parse(
        readFileSync(join(runDir, "run-processes", "pane-1-501.json"), "utf8")
      ).recordedAt;
    snapshot([row(501, 1, 501), row(601, 501, 601)], RECORDED_AT);
    expect(instant()).toBe(RECORDED_AT);
    // Same group later: kept, and its instant (and the pane record's) moves
    // up to this snapshot, carrying the proof of identity forward.
    snapshot([row(501, 1, 501), row(601, 501, 601)], SNAPSHOT_AT);
    expect(instant()).toBe(SNAPSHOT_AT);
    expect(paneInstant()).toBe(SNAPSHOT_AT);
    // The shell exited; a build it started before the last snapshot lives on,
    // reparented. No longer a descendant, but provably the same group: kept,
    // and still moved up, so a teardown can identify and end it.
    snapshot([row(501, 1, 501), row(602, 1, 601, at(SNAPSHOT_AT) - 1000)], T3);
    expect(groupFiles(runDir)).toEqual(["agent-group-601.json"]);
    expect(instant()).toBe(T3);
    // The group emptied and an unrelated process (started after the record)
    // now holds the id: not provably the recorded group, so its instant is
    // NOT moved up (the record stays evidence, never a termination target).
    snapshot([row(501, 1, 501), row(611, 1, 601, at(T4) - 500)], T4);
    expect(instant()).toBe(T3);
    // The id now leads a later group of the CLI itself: every member started
    // after the record, so the record is replaced by a fresh one.
    snapshot([row(501, 1, 501), row(601, 501, 601, at(T4) - 500)], T4);
    expect(instant()).toBe(T4);
    // Absent from the table but kill(0) still finds a member (EPERM or a
    // process started after the snapshot): kept.
    snapshot([row(501, 1, 501)], T4, (pgid) => pgid === 601);
    expect(groupFiles(runDir)).toEqual(["agent-group-601.json"]);
    // Gone: pruned, so the directory does not grow with every tool call.
    const result = snapshot([row(501, 1, 501)], T4);
    expect(result.pruned).toEqual([601]);
    expect(groupFiles(runDir)).toEqual([]);
    // A malformed record is never pruned: it stays unreadable evidence.
    writeFileSync(
      join(runDir, "run-processes", "agent-group-602.json"),
      "{not json"
    );
    snapshot([row(501, 1, 501)], T4);
    expect(groupFiles(runDir)).toEqual(["agent-group-602.json"]);
  });
});

// --- Re-identification before a signal ---------------------------------------

test("a target is the recorded group only while a member started by its reference instant lives", () => {
  const target = {
    id: 601,
    kind: "group" as const,
    reference: SNAPSHOT_AT,
    source: "agent %1 descendant",
  };
  expect(targetStillRecorded(target, [row(602, 1, 601)])).toBe(true);
  // Only members started after the reference: a later group reusing the id.
  expect(targetStillRecorded(target, [row(601, 1, 601, AFTER)])).toBe(false);
  expect(targetStillRecorded(target, [])).toBe(false);
  // A start time `ps` truncated to the reference's own second counts as
  // started by it.
  expect(targetStillRecorded(target, [row(603, 1, 601, at(SNAPSHOT_AT))])).toBe(
    true
  );
  expect(
    targetStillRecorded({ ...target, reference: "not a time" }, [
      row(602, 1, 601),
    ])
  ).toBe(false);
  // Without a reference the caller vouches for the target.
  expect(targetStillRecorded({ id: 601, kind: "group", source: "x" }, [])).toBe(
    true
  );
  // A single process: the live process with the id started by then.
  expect(
    targetStillRecorded(
      { id: 700, kind: "process", reference: SNAPSHOT_AT, source: "x" },
      [row(700, 1, 1)]
    )
  ).toBe(true);
  expect(
    targetStillRecorded(
      { id: 700, kind: "process", reference: SNAPSHOT_AT, source: "x" },
      [row(700, 1, 1, AFTER)]
    )
  ).toBe(false);
});

test("termination re-identifies each target before SIGTERM and again before SIGKILL, and never signals a reused id", async () => {
  const live = new Set([6001, 6002, 6003, 6004]);
  // 6001 is reused before the first round; 6002 is reused during the grace;
  // 6003 is the recorded group throughout and ignores SIGTERM; 6004 carries
  // no reference and is trusted.
  let round = 0;
  const signals: string[] = [];
  let clock = 0;
  const deps: TerminationDeps = {
    graceMs: 1000,
    isPidAlive: () => false,
    killWaitMs: 500,
    nowMs: () => clock,
    pollMs: 100,
    processGroupAlive: (pgid) => live.has(pgid),
    signal: (id, signal) => {
      signals.push(`${id}:${signal}`);
      if (signal === "SIGKILL") {
        live.delete(Math.abs(id));
      }
    },
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    stillRecorded: (targets) => {
      round += 1;
      const still = new Set<string>();
      for (const target of targets) {
        const reused =
          target.id === 6001 ||
          target.id === 6005 ||
          (target.id === 6002 && round > 1);
        if (!reused) {
          still.add(`${target.kind}:${target.id}`);
        }
      }
      return still;
    },
  };
  const result = await terminateTargets(
    [
      { id: 6001, kind: "group", reference: SNAPSHOT_AT, source: "a" },
      { id: 6002, kind: "group", reference: SNAPSHOT_AT, source: "b" },
      { id: 6003, kind: "group", reference: SNAPSHOT_AT, source: "c" },
      { id: 6004, kind: "group", source: "d" },
      // Already gone when re-identified: reported exited, never signalled.
      { id: 6005, kind: "group", reference: SNAPSHOT_AT, source: "e" },
    ],
    deps
  );
  expect(signals).toEqual([
    "-6002:SIGTERM",
    "-6003:SIGTERM",
    "-6004:SIGTERM",
    "-6003:SIGKILL",
    "-6004:SIGKILL",
  ]);
  expect(result).toEqual({
    exited: ["e process group 6005"],
    failed: [],
    killed: ["c process group 6003", "d process group 6004"],
    survivors: [],
    unverified: ["a process group 6001", "b process group 6002"],
  });
  // The production deps re-identify too.
  expect(defaultTerminationDeps().stillRecorded).toBeDefined();
});

// --- Teardown collection and the governess cycle -----------------------------

test("teardown targets the recorded agent groups present in its snapshot, with the snapshot as reference", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-descendants-collect-"));
  try {
    writePane(runDir, "%1", 501);
    const deps = runProcessCleanupInternals.deps;
    deps.now = () => SNAPSHOT_AT;
    deps.ownProcessGroup = () => 4242;
    deps.processGroupAlive = () => false;
    deps.listRunPanes = () => undefined;
    deps.processTable = () => [
      row(501, 1, 501),
      row(601, 501, 601),
      row(701, 501, 701),
      row(801, 501, 801),
    ];
    collectRunAgentGroups(runDir, undefined);
    // Later: 601's group is gone and not targeted; 701 keeps a member that
    // was there at the record; 801's id is held only by a process started
    // after the record (a reused id), so it is reported, never targeted.
    // 701's member re-parented to launchd: it stays a target because it
    // works inside the run's workspace (see shared-process-ownership.test).
    deps.processTable = () => [row(7011, 1, 701), row(8011, 1, 801, AFTER)];
    deps.otherRunIndex = () => ({ kind: "read", references: [], runs: [] });
    deps.cwdOfPid = () => "/ws/repo/src";
    const result = collectRunAgentGroups(runDir, {
      cwd: "/ws/repo",
    } as RunManifest);
    expect(result.groups).toEqual([
      {
        id: 701,
        kind: "group",
        ownership: "inferred",
        reference: SNAPSHOT_AT,
        rule: "reparented-in-workspace",
        source: "agent %1 descendant",
      },
    ]);
    expect(result.skipped).toEqual([
      { pid: 801, reason: "agent-group-unverified: agent %1 descendant" },
    ]);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("the governess snapshots the agent descendants on its cycle, at most once per interval, never once its teardown began", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-descendants-cycle-"));
  try {
    let snapshots = 0;
    const deps = runProcessCleanupInternals.deps;
    deps.processTable = () => {
      snapshots += 1;
      return [row(501, 1, 501)];
    };
    deps.ownProcessGroup = () => undefined;
    recordRunAgentDescendantsThrottled(runDir, 1_000_000);
    recordRunAgentDescendantsThrottled(runDir, 1_000_001);
    expect(snapshots).toBe(1);
    recordRunAgentDescendantsThrottled(
      runDir,
      1_000_000 + AGENT_DESCENDANT_SNAPSHOT_INTERVAL_MS
    );
    expect(snapshots).toBe(2);

    const config = {
      epoch: 1,
      logFile: join(runDir, "governess.jsonl"),
      runDir,
    } as unknown as GovernessConfig;
    const logged: string[] = [];
    let calls = 0;
    const governessDeps = {
      appendLog: (_file: string, record: unknown) => {
        logged.push((record as { event: string }).event);
      },
      recordAgentDescendants: () => {
        calls += 1;
        if (calls === 2) {
          throw new Error("ps failed");
        }
      },
    } as unknown as GovernessDeps;
    recordAgentDescendantGroupsOnCycle(config, governessDeps, SNAPSHOT_AT);
    recordAgentDescendantGroupsOnCycle(config, governessDeps, SNAPSHOT_AT);
    expect(calls).toBe(2);
    expect(logged).toEqual(["agent-descendants-record-failed"]);
    // Once the teardown began, it takes its own snapshot right before the
    // kill; the cycle takes none.
    expect(governessTeardownInProgress(config)).toBe(false);
    await stopGovernessLoop(
      config,
      {
        ...governessDeps,
        fenceCurrent: () => true,
        now: () => at(SNAPSHOT_AT),
      } as unknown as GovernessDeps,
      "test teardown"
    );
    expect(governessTeardownInProgress(config)).toBe(true);
    recordAgentDescendantGroupsOnCycle(config, governessDeps, SNAPSHOT_AT);
    expect(calls).toBe(2);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

// --- Real processes -----------------------------------------------------------

const readLine = async (
  stream: ReadableStream<Uint8Array>
): Promise<string> => {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return text.trim();
};

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
};

const sizeOf = (path: string): number =>
  existsSync(path) ? statSync(path).size : 0;

test("real: a tool subprocess in its own session outlives the pane group, blocks the release, and the teardown's termination ends it", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-descendants-real-"));
  const runDir = join(root, "run");
  const workspaceFile = join(root, "workspace-writes.log");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      ...createRunManifest(
        {
          cwd: root,
          mode: "paired",
          pid: 4_000_001,
          repoId: "repo-real",
          runId: "91",
          state: "stopped",
          workspaceBinding: {
            branchRef: "refs/heads/main",
            repoId: "repo-real",
            root,
          },
        },
        RECORDED_AT
      ),
      state: "stopped",
      status: "stopped",
      tmuxPaneGoverness: "%3",
      tmuxPaneLeft: "%1",
      tmuxSession: "loop-91",
      // Never contacted: the runtime is reported absent below.
      tmuxSocket: "/tmp/ls-descendants/run.sock",
      updatedAt: RECORDED_AT,
    })}\n`
  );
  // A pane-like process (a detached group leader, as tmux starts a pane) that
  // starts a "tool" the way Claude Code starts a Bash tool shell: in a new
  // session of its own. The tool ignores the hangup and keeps writing.
  const tool = `trap '' HUP; while :; do echo w >> '${workspaceFile}'; sleep 0.05; done`;
  const pane = spawn(
    [
      "/bin/sh",
      "-c",
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die; exec @ARGV' /bin/sh -c "${tool}" & echo $!; wait`,
    ],
    { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" }
  );
  const panePgid = pane.pid;
  let toolPid = 0;
  try {
    toolPid = Number.parseInt(await readLine(pane.stdout), 10);
    expect(await waitFor(() => sizeOf(workspaceFile) > 0)).toBe(true);
    recordRunPaneProcesses({
      agentPaneIds: ["%1"],
      now: () => new Date().toISOString(),
      panes: [{ paneId: "%1", pid: panePgid }],
      runDir,
      session: "loop-91",
    });
    // The tool is outside the pane group: the pane record alone misses it.
    expect(
      readProcessTable()?.find((entry) => entry.pid === toolPid)?.pgid
    ).toBe(toolPid);
    const reconcile = () =>
      reconcileLegacyStoppedRun(manifestPath, "91", {
        groupCanStillOwnRun: (id, reference) =>
          groupCanStillOwnRun(id, reference, defaultPidOwnershipDeps),
        now: () => new Date().toISOString(),
        pidCanStillOwnRun: (id, reference) =>
          pidCanStillOwnRun(id, reference, defaultPidOwnershipDeps),
        runtimeAbsent: () => Promise.resolve(true),
        terminalState: "stopped",
      });
    // The teardown's pre-kill collection, with the production table and
    // probes (the panes are not listed: there is no tmux here).
    runProcessCleanupInternals.deps.listRunPanes = () => undefined;
    const collected = collectRunAgentGroups(runDir, undefined);
    expect(collected.groups?.map((target) => target.id).sort()).toEqual(
      [panePgid, toolPid].sort()
    );
    // The session kill ends the pane (its CLI); the tool lives on.
    killGroup(panePgid);
    await pane.exited;
    expect(await waitFor(() => !processGroupAlive(panePgid))).toBe(true);
    const before = sizeOf(workspaceFile);
    expect(await waitFor(() => sizeOf(workspaceFile) > before)).toBe(true);
    expect(await reconcile()).toMatchObject({
      reason: expect.stringContaining(
        `run-processes/agent-group-${toolPid}.json pid ${toolPid} (or a member of its process group)`
      ),
      status: "refused",
    });
    // The teardown's termination, as production runs it (short grace).
    const ended = await terminateTargets(collected.groups ?? [], {
      ...defaultTerminationDeps(),
      graceMs: 300,
    });
    expect(ended.survivors).toEqual([]);
    expect(ended.unverified).toBeUndefined();
    expect(processGroupAlive(toolPid)).toBe(false);
    const after = sizeOf(workspaceFile);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sizeOf(workspaceFile)).toBe(after);
    // Nothing of the run is left: the same evidence releases.
    expect(await reconcile()).toMatchObject({ status: "changed" });
    expect(readFileSync(manifestPath, "utf8")).toContain("workspaceReleasedAt");
  } finally {
    killGroup(panePgid);
    if (toolPid > 0) {
      killGroup(toolPid);
    }
    rmSync(root, { force: true, recursive: true });
  }
});

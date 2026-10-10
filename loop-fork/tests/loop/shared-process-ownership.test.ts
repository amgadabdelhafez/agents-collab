// Whose process is it: the shared-process guard of the dead-run teardown.
//
// A run's agent descendant groups are found by a ppid walk from its panes, so
// a long-lived process started from inside run A (a `loop` launch run from an
// agent's tool shell starts run B's Codex app-server) is recorded as A's. These
// tests pin that A's teardown never signals a process another live run records
// or names (`shared-process-skipped`, logged with that run's id), that such a
// process keeps A's workspace owned only while it works inside it, that a
// process whose ownership cannot be judged blocks and is never signalled, that
// a daemon that re-parented away is A's only while its cwd is in A's
// workspace, and that a utility worker target is re-verified right before
// every signal round.
//
// Most tests fake the process table, command lines and cwds. The tests named
// "real" start their own detached perl / sleep processes and end them. No tmux
// server is started or contacted in this file. HOME points at a fresh empty
// directory for the whole file, so the default probes (which read the other
// runs under HOME's storage root) never read the machine's own runs.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  confirmTeardownRelease,
  defaultGovernessDeps,
  type GovernessConfig,
  type GovernessDeps,
  stopGovernessLoop,
} from "../../src/loop/governess";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import {
  defaultStillRecorded,
  defaultTerminationDeps,
  type ProcessRow,
  type ProcessSnapshot,
  processGroupAlive,
  stillRecordedOn,
  type TerminationDeps,
  type TerminationTarget,
  terminateTargets,
} from "../../src/loop/process-group";
import {
  readAgentGroupRecords,
  recordAgentDescendantGroups,
  recordRunPaneProcesses,
} from "../../src/loop/run-pane-processes";
import {
  cleanupRunOwnedProcesses,
  collectRunAgentGroups,
  gcAbandonedRunProcesses,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  type RunManifest,
  readRunManifest,
  reconcileLegacyStoppedRun,
  writeRunManifest,
} from "../../src/loop/run-state";
import {
  classifyGroup,
  commandNamesRun,
  defaultOwnershipProbes,
  defaultStorageRoots,
  type OwnershipProbes,
  ownershipContext,
  readOtherRunIndex,
  recordedProcessClassifier,
  sharedTargetCheck,
} from "../../src/loop/shared-process-ownership";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";
import { UTILITY_WORKER_SUBCOMMAND } from "../../src/loop/utility-constants";

const RECORDED_AT = "2026-10-05T21:00:00.000Z";
const SNAPSHOT_AT = "2026-10-06T12:00:00.000Z";
const at = (iso: string): number => Date.parse(iso);
const BEFORE = at(RECORDED_AT) - 60_000;
const AFTER = at(SNAPSHOT_AT) + 60_000;
const APP_SERVER = 7000;
const PANE = 501;

const originalCleanupDeps = { ...runProcessCleanupInternals.deps };
afterEach(() => {
  Object.assign(runProcessCleanupInternals.deps, originalCleanupDeps);
});

const originalHome = process.env.HOME;
let isolatedHome = "";
beforeAll(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "loop-shared-home-"));
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(isolatedHome, { force: true, recursive: true });
});

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  startedAtMs: number | undefined = BEFORE
): ProcessRow => ({ pgid, pid, ppid, startedAtMs });

interface TwoRuns {
  /** Run A (being torn down), its manifest path and workspace. */
  a: { manifestPath: string; runDir: string; workspace: string };
  /** Run B (another run), its manifest path and workspace. */
  b: { manifestPath: string; runDir: string; workspace: string };
  /** `<root>/.loop/runs`, the storage root both live under. */
  storage: string;
}

const writeRun = (
  storage: string,
  runId: string,
  workspace: string,
  overrides: Partial<RunManifest>
): { manifestPath: string; runDir: string; workspace: string } => {
  const runDir = join(storage, "repo-shared", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeRunManifest(manifestPath, {
    ...createRunManifest(
      {
        cwd: workspace,
        mode: "paired",
        pid: 4_100_000 + Number(runId),
        repoId: "repo-shared",
        runId,
        workspaceBinding: {
          branchRef: `refs/heads/run-${runId}`,
          repoId: "repo-shared",
          root: workspace,
        },
      },
      RECORDED_AT
    ),
    tmuxPaneGoverness: "%3",
    tmuxPaneLeft: "%1",
    tmuxSession: `repo-shared-loop-${runId}`,
    tmuxSocket: `/tmp/ls-shared-test/run-${runId}.sock`,
    updatedAt: RECORDED_AT,
    ...overrides,
  });
  return { manifestPath, runDir, workspace };
};

/** Run A stopped (its teardown), run B in `bState` with `bOverrides`. */
const withTwoRuns = async (
  bState: "stopped" | "working",
  bOverrides: Partial<RunManifest>,
  run: (runs: TwoRuns) => void | Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "loop-shared-"));
  const storage = join(root, "home", ".loop", "runs");
  try {
    const a = writeRun(storage, "1", join(root, "ws-a"), {
      state: "stopped",
      status: "stopped",
    });
    const b = writeRun(storage, "2", join(root, "ws-b"), {
      state: bState,
      status: bState === "stopped" ? "stopped" : "running",
      ...bOverrides,
    });
    await run({ a, b, storage });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

/** A's pane (%1, pid 501) and the walk that recorded `pgid` as A's. */
const recordWalkedGroup = (runDir: string, pgid: number): void => {
  recordRunPaneProcesses({
    agentPaneIds: ["%1"],
    now: () => RECORDED_AT,
    panes: [{ paneId: "%1", pid: PANE }],
    pgidOf: () => PANE,
    runDir,
    session: "repo-shared-loop-1",
  });
  // The launcher of the other run ran in A's tool shell (601) and started
  // the app-server as its child, in a group of its own.
  recordAgentDescendantGroups({
    groupAlive: () => true,
    now: () => RECORDED_AT,
    runDir,
    table: [
      row(PANE, 1, PANE),
      row(601, PANE, 601),
      row(602, 601, 601),
      row(pgid, 602, pgid),
    ],
  });
};

const fakeProbes = (
  storage: string,
  table: readonly ProcessRow[],
  cwds: Record<number, string>,
  commands: Record<number, string> = {}
): OwnershipProbes => ({
  commandTable: () =>
    new Map(Object.entries(commands).map(([pid, cmd]) => [Number(pid), cmd])),
  cwdOfPid: (pid) => cwds[pid],
  // A terminal run is dead only when what it records is gone from the fake
  // table; every run's tmux runtime is faked as positively gone (no tmux
  // server is contacted).
  otherRunIndex: (runDir, snapshot) =>
    readOtherRunIndex(runDir, [storage], {
      runtimeAbsent: () => true,
      table: snapshot ?? table,
    }),
  processTable: () => table,
});

const useCleanupProbes = (probes: OwnershipProbes): void => {
  const deps = runProcessCleanupInternals.deps;
  Object.assign(deps, probes);
  deps.now = () => SNAPSHOT_AT;
  deps.ownProcessGroup = () => 4242;
  deps.processGroupAlive = () => true;
  deps.listRunPanes = () => undefined;
};

const reconcileA = (
  manifestPath: string,
  classify?: ReturnType<typeof recordedProcessClassifier>,
  aliveGroups: readonly number[] = [APP_SERVER]
) =>
  reconcileLegacyStoppedRun(manifestPath, "1", {
    ...(classify ? { classifyRecordedProcess: classify } : {}),
    groupCanStillOwnRun: (pgid) => aliveGroups.includes(pgid),
    now: () => SNAPSHOT_AT,
    pidCanStillOwnRun: (pid) => aliveGroups.includes(pid),
    runtimeAbsent: () => Promise.resolve(true),
    terminalState: "stopped",
  });

const inferredTarget = (id: number): TerminationTarget => ({
  id,
  kind: "group",
  ownership: "inferred",
  reference: SNAPSHOT_AT,
  source: "agent %1 descendant",
});

const fakeTermination = (
  signals: string[],
  overrides: Partial<TerminationDeps> = {}
): TerminationDeps => ({
  graceMs: 0,
  isPidAlive: () => true,
  killWaitMs: 0,
  nowMs: () => 0,
  pollMs: 0,
  processGroupAlive: () => true,
  signal: (id, signal) => {
    signals.push(`${id}:${signal}`);
  },
  sleep: () => Promise.resolve(),
  ...overrides,
});

// --- (a) A shared app-server another live run records -------------------------

test("A tears down while B uses a shared app-server recorded in B's manifest: the app-server is never targeted or signalled, and A releases", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    async ({ a, b, storage }) => {
      recordWalkedGroup(a.runDir, APP_SERVER);
      // Teardown time: A's pane CLI is still alive; the app-server re-parented
      // to launchd when B's launcher exited, and works in B's workspace.
      const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
      const probes = fakeProbes(storage, table, {
        [APP_SERVER]: b.workspace,
        [PANE]: a.workspace,
      });
      useCleanupProbes(probes);
      const collected = collectRunAgentGroups(
        a.runDir,
        readRunManifest(a.manifestPath)
      );
      expect(collected.groups?.map((target) => target.id)).toEqual([PANE]);
      expect(collected.skipped).toEqual([
        {
          detail: expect.stringContaining(
            "recorded by run 2 as codexAppServerPid (pid 7000)"
          ),
          otherRunId: "2",
          pid: APP_SERVER,
          reason: "shared-process-skipped",
        },
      ]);
      // Even a target collected earlier is re-checked before every signal.
      const signals: string[] = [];
      const ended = await terminateTargets(
        [inferredTarget(APP_SERVER)],
        fakeTermination(signals, {
          sharedSkips: sharedTargetCheck(
            a.runDir,
            () => readRunManifest(a.manifestPath),
            probes
          ),
        })
      );
      expect(signals).toEqual([]);
      expect(ended.shared).toEqual([
        {
          detail: expect.stringContaining("recorded by run 2"),
          otherRunId: "2",
          reason: "shared-process-skipped",
          target: "agent %1 descendant process group 7000",
        },
      ]);
      expect(ended.exited).toEqual([]);
      // Release: the live shared app-server works outside A's workspace, so
      // it does not keep A's workspace owned (the control without the
      // classifier is refused on it).
      expect(await reconcileA(a.manifestPath)).toMatchObject({
        reason: expect.stringContaining(
          "run-processes/agent-group-7000.json pid 7000"
        ),
        status: "refused",
      });
      expect(
        await reconcileA(a.manifestPath, recordedProcessClassifier(probes))
      ).toMatchObject({ status: "changed" });
    }
  );
});

test("the teardown's own handback applies the same rule and names the live record it did not count", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    async ({ a, b, storage }) => {
      recordWalkedGroup(a.runDir, APP_SERVER);
      const probes = fakeProbes(storage, [row(APP_SERVER, 1, APP_SERVER)], {
        [APP_SERVER]: b.workspace,
      });
      const confirm = (classify: boolean) =>
        confirmTeardownRelease(a.manifestPath, "1", {
          attempts: 1,
          ...(classify
            ? { classifyRecordedProcess: recordedProcessClassifier(probes) }
            : {}),
          groupCanStillOwnRun: (pgid) => pgid === APP_SERVER,
          now: () => SNAPSHOT_AT,
          pidCanStillOwnRun: () => false,
          retryMs: 0,
          runtimeAbsent: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
        });
      expect(await confirm(false)).toMatchObject({ released: false });
      const released = await confirm(true);
      expect(released.released).toBe(true);
      expect(released.detail).toContain(
        "not counted: run-processes/agent-group-7000.json pid 7000 (shared-process-skipped: recorded by run 2"
      );
    }
  );
});

test("startup GC never signals A's app-server that live B records too, and hands A's workspace back", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    ({ a, b, storage }) => {
      writeRunManifest(a.manifestPath, {
        ...(readRunManifest(a.manifestPath) as RunManifest),
        codexAppServerPid: APP_SERVER,
        codexRemoteUrl: "ws://127.0.0.1:4500",
      });
      const signals: string[] = [];
      const result = gcAbandonedRunProcesses({
        deps: {
          ...fakeProbes(storage, [row(APP_SERVER, 1, APP_SERVER)], {
            [APP_SERVER]: b.workspace,
          }),
          commandForPid: () => "codex app-server --listen ws://127.0.0.1:4500",
          listTmuxSessions: () => new Set(["repo-shared-loop-2"]),
          listeningPids: () => [APP_SERVER],
          pidAlive: (pid) => pid === APP_SERVER,
          pidStartedAt: () => BEFORE,
          processGroupAlive: (pgid) => pgid === APP_SERVER,
          runtimeAbsent: () => true,
          signal: (pid, signal) => {
            signals.push(`${pid}:${signal}`);
          },
        },
        log: () => undefined,
        repoId: "repo-shared",
        storageRoot: storage,
      });
      expect(signals).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          otherRunId: "2",
          pid: APP_SERVER,
          reason: "shared-process-skipped",
        })
      );
      expect(readRunManifest(a.manifestPath)).toMatchObject({
        codexAppServerPid: APP_SERVER,
        workspaceReleasedAt: expect.any(String),
      });
      expect(readRunManifest(b.manifestPath)?.state).toBe("working");
    }
  );
});

test("same, but B is terminal and the app-server it records still lives: B is not provably dead, so A never ends it", async () => {
  await withTwoRuns(
    "stopped",
    { codexAppServerPid: APP_SERVER },
    async ({ a, storage }) => {
      recordWalkedGroup(a.runDir, APP_SERVER);
      const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
      const probes = fakeProbes(storage, table, {
        [APP_SERVER]: join(a.workspace, "sub"),
      });
      useCleanupProbes(probes);
      const collected = collectRunAgentGroups(
        a.runDir,
        readRunManifest(a.manifestPath)
      );
      expect(collected.groups?.map((target) => target.id)).toEqual([PANE]);
      expect(collected.skipped).toMatchObject([
        { otherRunId: "2", pid: APP_SERVER, reason: "shared-process-skipped" },
      ]);
      const signals: string[] = [];
      await terminateTargets(
        [inferredTarget(APP_SERVER)],
        fakeTermination(signals, {
          processGroupAlive: () => false,
          sharedSkips: sharedTargetCheck(
            a.runDir,
            () => readRunManifest(a.manifestPath),
            probes
          ),
        })
      );
      expect(signals).toEqual([]);
    }
  );
});

test("a terminal run is dead only when its pids and groups are gone AND its tmux runtime is positively gone", async () => {
  await withTwoRuns(
    "stopped",
    { codexAppServerPid: APP_SERVER, launchAttemptPid: 7001 },
    ({ a, b, storage }) => {
      mkdirSync(join(b.runDir, "run-processes"), { recursive: true });
      writeFileSync(
        join(b.runDir, "run-processes", "agent-group-7002.json"),
        `${JSON.stringify({
          kind: "agent-descendant-group",
          paneId: "%1",
          pgid: 7002,
          recordedAt: RECORDED_AT,
          runDir: b.runDir,
        })}\n`
      );
      const runIds = (
        table: readonly ProcessRow[],
        runtimeAbsent: boolean
      ): string[] => {
        const index = readOtherRunIndex(a.runDir, [storage], {
          runtimeAbsent: () => runtimeAbsent,
          table,
        });
        return index.kind === "read" ? index.runs.map((run) => run.runId) : [];
      };
      // Every record gone and the runtime gone: dead.
      expect(runIds([], true)).toEqual([]);
      // Any one of them still live, or the runtime not positively gone: B
      // still counts as live.
      expect(runIds([], false)).toEqual(["2"]);
      expect(runIds([row(APP_SERVER, 1, APP_SERVER)], true)).toEqual(["2"]);
      expect(runIds([row(7001, 1, 7001)], true)).toEqual(["2"]);
      expect(runIds([row(7003, 1, 7002)], true)).toEqual(["2"]);
      // A pid held only by a process started after B's last update (and
      // after the record) is a later process: B is still dead.
      expect(runIds([row(APP_SERVER, 1, APP_SERVER, AFTER)], true)).toEqual([]);
      // A terminal run whose records cannot be read is not provably dead.
      writeFileSync(
        join(b.runDir, "run-processes", "agent-group-7004.json"),
        "{ torn"
      );
      expect(
        readOtherRunIndex(a.runDir, [storage], {
          runtimeAbsent: () => true,
          table: [],
        })
      ).toMatchObject({ kind: "unknown" });
    }
  );
});

test("same, but B is provably dead (terminal, nothing it records live, its tmux runtime gone): A may end the app-server it started in its workspace", async () => {
  await withTwoRuns(
    "stopped",
    // B's own teardown settled its app-server record; the process A's walk
    // recorded is no longer B's.
    {},
    async ({ a, storage }) => {
      recordWalkedGroup(a.runDir, APP_SERVER);
      const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
      const probes = fakeProbes(storage, table, {
        [APP_SERVER]: join(a.workspace, "sub"),
      });
      useCleanupProbes(probes);
      const collected = collectRunAgentGroups(
        a.runDir,
        readRunManifest(a.manifestPath)
      );
      expect(collected.groups).toContainEqual({
        id: APP_SERVER,
        kind: "group",
        ownership: "inferred",
        reference: SNAPSHOT_AT,
        rule: "reparented-in-workspace",
        source: "agent %1 descendant",
      });
      expect(collected.skipped).toEqual([]);
      const signals: string[] = [];
      await terminateTargets(
        [inferredTarget(APP_SERVER)],
        fakeTermination(signals, {
          processGroupAlive: () => false,
          sharedSkips: sharedTargetCheck(
            a.runDir,
            () => readRunManifest(a.manifestPath),
            probes
          ),
        })
      );
      expect(signals).toEqual(["-7000:SIGTERM"]);
    }
  );
});

test("a shared daemon whose cwd is inside A's workspace blocks A's release but is never signalled while B references it", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    async ({ a, storage }) => {
      recordWalkedGroup(a.runDir, APP_SERVER);
      const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
      const probes = fakeProbes(storage, table, {
        [APP_SERVER]: a.workspace,
      });
      useCleanupProbes(probes);
      const collected = collectRunAgentGroups(
        a.runDir,
        readRunManifest(a.manifestPath)
      );
      expect(collected.groups?.map((target) => target.id)).toEqual([PANE]);
      expect(collected.skipped).toMatchObject([
        { otherRunId: "2", pid: APP_SERVER, reason: "shared-process-skipped" },
      ]);
      const signals: string[] = [];
      await terminateTargets(
        [inferredTarget(APP_SERVER)],
        fakeTermination(signals, {
          sharedSkips: sharedTargetCheck(
            a.runDir,
            () => readRunManifest(a.manifestPath),
            probes
          ),
        })
      );
      expect(signals).toEqual([]);
      expect(
        await reconcileA(a.manifestPath, recordedProcessClassifier(probes))
      ).toMatchObject({
        reason: expect.stringContaining(
          "run-processes/agent-group-7000.json pid 7000"
        ),
        status: "refused",
      });
    }
  );
});

test("A's own manifest app-server that live B records too is never signalled by A's cleanup", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    ({ a, b, storage }) => {
      const probes = fakeProbes(storage, [row(APP_SERVER, 1, APP_SERVER)], {
        [APP_SERVER]: b.workspace,
      });
      useCleanupProbes(probes);
      const signals: string[] = [];
      const deps = runProcessCleanupInternals.deps;
      deps.commandForPid = () =>
        "codex app-server --listen ws://127.0.0.1:4500";
      deps.listeningPids = () => [APP_SERVER];
      deps.signal = (pid, signal) => {
        signals.push(`${pid}:${signal}`);
      };
      const manifest = {
        ...(readRunManifest(a.manifestPath) as RunManifest),
        codexAppServerPid: APP_SERVER,
        codexRemoteUrl: "ws://127.0.0.1:4500",
      };
      const result = cleanupRunOwnedProcesses(a.runDir, manifest);
      expect(signals).toEqual([]);
      expect(result.skipped).toContainEqual({
        detail: expect.stringContaining("codexAppServerPid: recorded by run 2"),
        otherRunId: "2",
        pid: APP_SERVER,
        reason: "shared-process-skipped",
      });
      // B's manifest turning terminal while it still records the live
      // app-server does not make B dead: still never signalled.
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        state: "stopped",
        status: "stopped",
      });
      cleanupRunOwnedProcesses(a.runDir, manifest);
      expect(signals).toEqual([]);
      // Control: once B is provably dead (it no longer records a live
      // process, and its runtime is gone), the same cleanup ends A's
      // app-server.
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        codexAppServerPid: undefined,
      });
      cleanupRunOwnedProcesses(a.runDir, manifest);
      expect(signals).toEqual(["-7000:SIGTERM"]);
    }
  );
});

// --- The run's own explicit records while other runs cannot be read -----------

const APP_SERVER_URL = "ws://127.0.0.1:4500";

/** Run B's records are unreadable (a torn `run-processes/` record). */
const makeUnreadable = (runDir: string): void => {
  mkdirSync(join(runDir, "run-processes"), { recursive: true });
  writeFileSync(join(runDir, "run-processes", "bridge-9.json"), "{ torn");
};

test("with another run unreadable, A's own app-server is signalled only when its identity is bound positively: the exact recorded listen URL, its listener, and a start no later than the record", async () => {
  await withTwoRuns("working", {}, ({ a, b, storage }) => {
    makeUnreadable(b.runDir);
    expect(
      readOtherRunIndex(a.runDir, [storage], { runtimeAbsent: () => true })
    ).toMatchObject({ kind: "unknown" });
    const signals: string[] = [];
    const cleanupWith = (input: {
      command: string;
      startedAt?: number | "unknown";
      url?: string;
    }) => {
      const startedAtMs =
        input.startedAt === "unknown" ? undefined : (input.startedAt ?? BEFORE);
      useCleanupProbes(
        fakeProbes(
          storage,
          [{ pgid: APP_SERVER, pid: APP_SERVER, ppid: 1, startedAtMs }],
          { [APP_SERVER]: "/elsewhere" }
        )
      );
      const deps = runProcessCleanupInternals.deps;
      deps.commandForPid = () => input.command;
      deps.listeningPids = (port) => (port === 4500 ? [APP_SERVER] : []);
      deps.signal = (pid, signal) => {
        signals.push(`${pid}:${signal}`);
      };
      const manifest = {
        ...(readRunManifest(a.manifestPath) as RunManifest),
        codexAppServerPid: APP_SERVER,
        ...(input.url ? { codexRemoteUrl: input.url } : {}),
      };
      return cleanupRunOwnedProcesses(a.runDir, manifest);
    };
    const bound = `codex app-server --listen ${APP_SERVER_URL}`;
    // Bound: ended, whatever the unreadable run holds.
    expect(cleanupWith({ command: bound, url: APP_SERVER_URL }).killed).toEqual(
      [APP_SERVER]
    );
    expect(signals).toEqual(["-7000:SIGTERM"]);
    signals.length = 0;
    // Unbound in each way: left alone, and the skip says why and that the
    // other runs were unreadable.
    const unbound: [string, Parameters<typeof cleanupWith>[0]][] = [
      [
        `its command does not listen on ${APP_SERVER_URL}`,
        {
          command: "codex app-server --listen ws://127.0.0.1:4501",
          url: APP_SERVER_URL,
        },
      ],
      [
        "it started after the record",
        { command: bound, startedAt: AFTER, url: APP_SERVER_URL },
      ],
      [
        "its start time is unknown",
        { command: bound, startedAt: "unknown", url: APP_SERVER_URL },
      ],
      // An older run recorded no URL: unproven.
      ["the manifest records no codexRemoteUrl", { command: bound }],
    ];
    for (const [why, input] of unbound) {
      const result = cleanupWith(input);
      expect(signals, why).toEqual([]);
      expect(result.skipped, why).toEqual([
        {
          detail: expect.stringContaining("; other runs unreadable: "),
          pid: APP_SERVER,
          reason: "app-server-identity-mismatch",
        },
      ]);
      expect(result.skipped[0]?.detail, why).toStartWith(
        `identity not proven: ${why}`
      );
    }
  });
});

test("with another run unreadable, a readable live run that records A's explicit record still makes it shared: A's app-server and A's pane group are never signalled", async () => {
  await withTwoRuns("working", {}, ({ a, b, storage }) => {
    makeUnreadable(b.runDir);
    // C is live and readable, and records both (its manifest's app-server,
    // and its bridge worker pid naming A's pane group's leader).
    const c = writeRun(storage, "3", join(a.workspace, "..", "ws-c"), {
      codexAppServerPid: APP_SERVER,
      state: "working",
      status: "running",
    });
    writeFileSync(
      join(c.runDir, "bridge-worker.json"),
      `${JSON.stringify({ pid: PANE })}\n`
    );
    const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
    const probes = fakeProbes(storage, table, { [APP_SERVER]: "/elsewhere" });
    useCleanupProbes(probes);
    const signals: string[] = [];
    const deps = runProcessCleanupInternals.deps;
    deps.commandForPid = () => `codex app-server --listen ${APP_SERVER_URL}`;
    deps.listeningPids = () => [APP_SERVER];
    deps.signal = (pid, signal) => {
      signals.push(`${pid}:${signal}`);
    };
    const result = cleanupRunOwnedProcesses(a.runDir, {
      ...(readRunManifest(a.manifestPath) as RunManifest),
      codexAppServerPid: APP_SERVER,
      codexRemoteUrl: APP_SERVER_URL,
    });
    expect(signals).toEqual([]);
    expect(result.skipped).toEqual([
      {
        detail: expect.stringContaining(
          "recorded by run 3 as codexAppServerPid"
        ),
        otherRunId: "3",
        pid: APP_SERVER,
        reason: "shared-process-skipped",
      },
    ]);
    const check = sharedTargetCheck(
      a.runDir,
      () => readRunManifest(a.manifestPath),
      probes
    );
    expect(
      check([
        { id: PANE, kind: "group", reference: SNAPSHOT_AT, source: "pane" },
      ]).get(`group:${PANE}`)
    ).toMatchObject({ otherRunId: "3", reason: "shared-process-skipped" });
    // Without C's record the pane group (bound by its reference instant) is
    // signalled; an explicit target that carries no identity at all is not
    // while the other runs cannot be read.
    rmSync(c.runDir, { force: true, recursive: true });
    expect(
      check([
        { id: PANE, kind: "group", reference: SNAPSHOT_AT, source: "pane" },
      ]).size
    ).toBe(0);
    expect(
      check([{ id: PANE, kind: "group", source: "pane" }]).get(`group:${PANE}`)
    ).toMatchObject({
      detail: expect.stringContaining("no identity binds it to this run"),
      reason: "ownership-unknown",
    });
  });
});

test("a command line that names another live run's directory, socket, session or run id makes the process shared; this run's own session or run id does not", async () => {
  await withTwoRuns("working", {}, ({ a, b, storage }) => {
    const other = {
      runDir: b.runDir,
      runId: "2",
      session: "repo-shared-loop-2",
      socket: "/tmp/ls-shared-test/run-2.sock",
    };
    expect(commandNamesRun(`loop __bridge-worker ${b.runDir}`, other)).toBe(
      "run directory"
    );
    expect(commandNamesRun(`tail -f ${b.runDir}/governess.jsonl`, other)).toBe(
      "run directory"
    );
    // A directory whose name only starts with the run directory is another.
    expect(commandNamesRun(`ls ${b.runDir}0/x`, other)).toBeUndefined();
    expect(
      commandNamesRun("tmux -S /tmp/ls-shared-test/run-2.sock ls", other)
    ).toBe("tmux socket");
    expect(commandNamesRun("tmux attach -t repo-shared-loop-2:0", other)).toBe(
      "tmux session"
    );
    expect(commandNamesRun("loop --run-id 2 --resume", other)).toBe("run id");
    expect(commandNamesRun("loop --run-id=2", other)).toBe("run id");
    expect(commandNamesRun("sleep 2", other)).toBeUndefined();
    // Run ids repeat across repositories: this run's own never matches.
    expect(
      commandNamesRun("loop --run-id 2", other, { runId: "2" })
    ).toBeUndefined();
    expect(
      commandNamesRun("tmux attach -t repo-shared-loop-2", other, {
        session: "repo-shared-loop-2",
      })
    ).toBeUndefined();

    // A walked group whose only link to B is a member naming B's directory
    // is shared: never signalled.
    recordWalkedGroup(a.runDir, 7100);
    const table = [row(PANE, 1, PANE), row(7100, PANE, 7100)];
    const probes = fakeProbes(
      storage,
      table,
      { 7100: a.workspace },
      { 7100: `loop __bridge-worker ${b.runDir}` }
    );
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.skipped).toMatchObject([
      {
        detail: expect.stringContaining("names run 2's run directory"),
        otherRunId: "2",
        pid: 7100,
        reason: "shared-process-skipped",
      },
    ]);
  });
});

test("another run's record of a group id whose members all started after the record names a later group, not this one", async () => {
  await withTwoRuns("working", {}, ({ a, b, storage }) => {
    // B recorded group 7200 long ago; the id now names A's tool group, every
    // member of which started after B's record.
    mkdirSync(join(b.runDir, "run-processes"), { recursive: true });
    writeFileSync(
      join(b.runDir, "run-processes", "agent-group-7200.json"),
      `${JSON.stringify({
        kind: "agent-descendant-group",
        paneId: "%1",
        pgid: 7200,
        recordedAt: RECORDED_AT,
        runDir: b.runDir,
      })}\n`
    );
    const ctx = ownershipContext({
      manifest: readRunManifest(a.manifestPath),
      probes: fakeProbes(storage, [], {}),
      runDir: a.runDir,
      table: [
        row(PANE, 1, PANE),
        row(7200, PANE, 7200, AFTER + 3_600_000 * 24 * 365),
      ],
    });
    // The file's mtime (now) is the reference: members started a year later.
    expect(classifyGroup(7200, ctx, { inferred: true }).rule).not.toBe(
      "shared-process-skipped"
    );
    // A member started before the record: B's group, shared.
    const older = ownershipContext({
      manifest: readRunManifest(a.manifestPath),
      probes: fakeProbes(storage, [], {}),
      runDir: a.runDir,
      table: [row(PANE, 1, PANE), row(7200, PANE, 7200)],
    });
    expect(classifyGroup(7200, older, { inferred: true })).toMatchObject({
      kill: false,
      otherRunId: "2",
      rule: "shared-process-skipped",
    });
  });
});

// --- (b)/(c) Unknown ownership and re-parented daemons --------------------------

test("unknown ownership (another run's records unreadable) blocks the release and is never signalled; the run's own pane group still is", async () => {
  await withTwoRuns("working", {}, async ({ a, b, storage }) => {
    // B's manifest is present but not JSON: B is not provably dead and its
    // references cannot be read.
    writeFileSync(b.manifestPath, "{ torn");
    recordWalkedGroup(a.runDir, 7300);
    const table = [row(PANE, 1, PANE), row(7300, PANE, 7300)];
    const probes = fakeProbes(storage, table, { 7300: "/elsewhere" });
    expect(readOtherRunIndex(a.runDir, [storage])).toMatchObject({
      kind: "unknown",
    });
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups?.map((target) => target.id)).toEqual([PANE]);
    expect(collected.skipped).toMatchObject([
      { pid: 7300, reason: "ownership-unknown" },
    ]);
    const signals: string[] = [];
    const ended = await terminateTargets(
      [
        inferredTarget(7300),
        { id: PANE, kind: "group", reference: SNAPSHOT_AT, source: "pane" },
      ],
      fakeTermination(signals, {
        processGroupAlive: () => false,
        sharedSkips: sharedTargetCheck(
          a.runDir,
          () => readRunManifest(a.manifestPath),
          probes
        ),
      })
    );
    expect(signals).toEqual([`-${PANE}:SIGTERM`]);
    expect(ended.shared).toMatchObject([{ reason: "ownership-unknown" }]);
    expect(
      await reconcileA(
        a.manifestPath,
        recordedProcessClassifier(probes),
        [7300]
      )
    ).toMatchObject({ status: "refused" });
  });
});

test("a daemon that re-parented away and no run references: signalled and counted only while its cwd is inside the workspace; an unreadable cwd blocks and is never signalled", async () => {
  await withTwoRuns("working", {}, async ({ a, storage }) => {
    recordWalkedGroup(a.runDir, 7400);
    const table = [row(PANE, 1, PANE), row(7400, 1, 7400)];
    const collect = (cwd: string | undefined) => {
      useCleanupProbes(fakeProbes(storage, table, cwd ? { 7400: cwd } : {}));
      return collectRunAgentGroups(a.runDir, readRunManifest(a.manifestPath));
    };
    const reconcile = (cwd: string | undefined) =>
      reconcileA(
        a.manifestPath,
        recordedProcessClassifier(
          fakeProbes(storage, table, cwd ? { 7400: cwd } : {})
        ),
        [7400]
      );

    // Outside the workspace (a shared watchman, an LM Studio server): not
    // A's to end, and not A's to wait for.
    const outside = collect("/Users/someone/.cache");
    expect(outside.groups?.map((target) => target.id)).toEqual([PANE]);
    expect(outside.skipped).toMatchObject([
      {
        detail: expect.stringContaining("cwd outside the workspace"),
        pid: 7400,
        reason: "reparented-outside-workspace",
      },
    ]);
    expect(await reconcile("/Users/someone/.cache")).toMatchObject({
      status: "changed",
    });
  });
  await withTwoRuns("working", {}, async ({ a, storage }) => {
    recordWalkedGroup(a.runDir, 7400);
    const table = [row(PANE, 1, PANE), row(7400, 1, 7400)];
    // Inside: today's behaviour (a `nohup make &` whose shell exited).
    useCleanupProbes(fakeProbes(storage, table, { 7400: a.workspace }));
    const inside = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(inside.groups).toContainEqual(
      expect.objectContaining({ id: 7400, rule: "reparented-in-workspace" })
    );
    expect(
      await reconcileA(
        a.manifestPath,
        recordedProcessClassifier(
          fakeProbes(storage, table, { 7400: a.workspace })
        ),
        [7400]
      )
    ).toMatchObject({ status: "refused" });
    // Unknown cwd: blocks, never signalled.
    useCleanupProbes(fakeProbes(storage, table, {}));
    const unknown = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(unknown.groups?.map((target) => target.id)).toEqual([PANE]);
    expect(unknown.skipped).toMatchObject([
      { pid: 7400, reason: "ownership-unknown" },
    ]);
    expect(
      await reconcileA(
        a.manifestPath,
        recordedProcessClassifier(fakeProbes(storage, table, {})),
        [7400]
      )
    ).toMatchObject({ status: "refused" });
  });
});

test("a walked group still attached to the run's live pane is the run's even with its cwd outside the workspace", async () => {
  await withTwoRuns("working", {}, ({ a, storage }) => {
    recordWalkedGroup(a.runDir, 7500);
    const table = [
      row(PANE, 1, PANE),
      row(601, PANE, 601),
      row(7500, 601, 7500),
    ];
    useCleanupProbes(fakeProbes(storage, table, { 7500: "/tmp" }));
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups).toContainEqual({
      id: 7500,
      kind: "group",
      ownership: "inferred",
      reference: SNAPSHOT_AT,
      source: "agent %1 descendant",
    });
  });
});

test("the storage roots are HOME's and, for a run in the storage layout, its own", () => {
  expect(defaultStorageRoots("/x/home/.loop/runs/repo/5", "/h")).toEqual([
    "/h/.loop/runs",
    "/x/home/.loop/runs",
  ]);
  expect(defaultStorageRoots("/tmp/loop-run-abc", "/h")).toEqual([
    "/h/.loop/runs",
  ]);
});

// --- Descendants of a shared process; what "re-parented" means -----------------

test("a walked group whose parent is a process live B records is shared, though no run records the group itself (a child B's app-server started in a group of its own)", async () => {
  await withTwoRuns(
    "working",
    { codexAppServerPid: APP_SERVER },
    async ({ a, storage }) => {
      const CHILD = 7800;
      recordWalkedGroup(a.runDir, CHILD);
      // The child's parent is B's app-server, which re-parented to launchd
      // when B's launcher exited; both kept the launcher's cwd, inside A's
      // workspace.
      const detached = [
        row(PANE, 1, PANE),
        row(APP_SERVER, 1, APP_SERVER),
        row(CHILD, APP_SERVER, CHILD),
      ];
      // The same while B's launcher (650) still runs in A's tool shell.
      const attached = [
        row(PANE, 1, PANE),
        row(601, PANE, 601),
        row(650, 601, 601),
        row(APP_SERVER, 650, APP_SERVER),
        row(CHILD, APP_SERVER, CHILD),
      ];
      for (const table of [detached, attached]) {
        const probes = fakeProbes(storage, table, {
          [APP_SERVER]: a.workspace,
          [CHILD]: a.workspace,
        });
        const ctx = ownershipContext({
          manifest: readRunManifest(a.manifestPath),
          probes,
          runDir: a.runDir,
          table,
        });
        expect(classifyGroup(CHILD, ctx, { inferred: true })).toMatchObject({
          detail: expect.stringContaining(`ancestor pid ${APP_SERVER}`),
          kill: false,
          otherRunId: "2",
          rule: "shared-process-skipped",
        });
        useCleanupProbes(probes);
        const collected = collectRunAgentGroups(
          a.runDir,
          readRunManifest(a.manifestPath)
        );
        expect(collected.groups?.map((target) => target.id)).not.toContain(
          CHILD
        );
        expect(collected.skipped).toContainEqual(
          expect.objectContaining({
            otherRunId: "2",
            pid: CHILD,
            reason: "shared-process-skipped",
          })
        );
        // Re-checked on a fresh table right before every signal round.
        const signals: string[] = [];
        const ended = await terminateTargets(
          [inferredTarget(CHILD)],
          fakeTermination(signals, {
            sharedSkips: sharedTargetCheck(
              a.runDir,
              () => readRunManifest(a.manifestPath),
              probes
            ),
          })
        );
        expect(signals).toEqual([]);
        expect(ended.shared).toMatchObject([
          { otherRunId: "2", reason: "shared-process-skipped" },
        ]);
      }
    }
  );
});

test("a walked group is re-parented only when its parent is launchd: one whose parent is any other process no run records is ownership-unknown (never signalled, counted) whatever its cwd, unless that parent is in a group A's own walk recorded", async () => {
  await withTwoRuns("working", {}, async ({ a, storage }) => {
    const GROUP = 7900;
    const STRANGER = 4444;
    recordWalkedGroup(a.runDir, GROUP);
    const table = [
      row(PANE, 1, PANE),
      row(STRANGER, 1, STRANGER),
      row(GROUP, STRANGER, GROUP),
    ];
    const probes = fakeProbes(storage, table, {
      [GROUP]: a.workspace,
      [STRANGER]: a.workspace,
    });
    const context = () =>
      ownershipContext({
        manifest: readRunManifest(a.manifestPath),
        probes,
        runDir: a.runDir,
        table,
      });
    expect(classifyGroup(GROUP, context(), { inferred: true })).toMatchObject({
      count: true,
      detail: expect.stringContaining(`parent ${STRANGER}`),
      kill: false,
      rule: "ownership-unknown",
    });
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups?.map((target) => target.id)).toEqual([PANE]);
    expect(collected.skipped).toMatchObject([
      { pid: GROUP, reason: "ownership-unknown" },
    ]);
    expect(
      await reconcileA(a.manifestPath, recordedProcessClassifier(probes), [
        GROUP,
      ])
    ).toMatchObject({ status: "refused" });
    // The parent leads a group A's walk recorded too (a daemon A's tool
    // started, which started GROUP): the chain reaches launchd through A's
    // own walked groups, so the re-parented rules apply.
    writeFileSync(
      join(a.runDir, "run-processes", `agent-group-${STRANGER}.json`),
      `${JSON.stringify({
        kind: "agent-descendant-group",
        paneId: "%1",
        pgid: STRANGER,
        recordedAt: RECORDED_AT,
        runDir: a.runDir,
      })}\n`
    );
    expect(classifyGroup(GROUP, context(), { inferred: true })).toMatchObject({
      kill: true,
      rule: "reparented-in-workspace",
    });
  });
});

test("the app-server's owner B tears down first while live A's walk records it too: B's cleanup ends its own app-server (even with another run unreadable), and B's release counts it as B's own", async () => {
  await withTwoRuns(
    "stopped",
    { codexAppServerPid: APP_SERVER, codexRemoteUrl: "ws://127.0.0.1:4500" },
    async ({ a, b, storage }) => {
      // A is live, and its walk recorded B's app-server (B was launched
      // from A's tool shell).
      writeRunManifest(a.manifestPath, {
        ...(readRunManifest(a.manifestPath) as RunManifest),
        state: "working",
        status: "running",
      });
      recordWalkedGroup(a.runDir, APP_SERVER);
      const table = [row(PANE, 1, PANE), row(APP_SERVER, 1, APP_SERVER)];
      const probes = fakeProbes(storage, table, {
        [APP_SERVER]: "/elsewhere",
      });
      useCleanupProbes(probes);
      const signals: string[] = [];
      const deps = runProcessCleanupInternals.deps;
      deps.commandForPid = () =>
        "codex app-server --listen ws://127.0.0.1:4500";
      deps.listeningPids = () => [APP_SERVER];
      deps.signal = (pid, signal) => {
        signals.push(`${pid}:${signal}`);
      };
      const result = cleanupRunOwnedProcesses(
        b.runDir,
        readRunManifest(b.manifestPath)
      );
      expect(signals).toEqual(["-7000:SIGTERM"]);
      expect(
        result.skipped.filter(
          (entry) => entry.reason === "shared-process-skipped"
        )
      ).toEqual([]);
      // Pre-signal check: a target of B's own record ignores A's walk
      // record; a walked target of B's that A's walk records too is shared.
      const check = sharedTargetCheck(
        b.runDir,
        () => readRunManifest(b.manifestPath),
        probes
      );
      expect(
        check([
          {
            id: APP_SERVER,
            kind: "group",
            reference: SNAPSHOT_AT,
            source: "agent pane %1",
          },
        ]).size
      ).toBe(0);
      expect(
        check([inferredTarget(APP_SERVER)]).get(`group:${APP_SERVER}`)
      ).toMatchObject({ otherRunId: "1", reason: "shared-process-skipped" });
      // Release: B's own app-server counts as B's while it lives, wherever
      // its cwd, and stops counting once it is gone.
      const reconcileB = (alive: readonly number[]) =>
        reconcileLegacyStoppedRun(b.manifestPath, "2", {
          classifyRecordedProcess: recordedProcessClassifier(probes),
          groupCanStillOwnRun: (pgid) => alive.includes(pgid),
          now: () => SNAPSHOT_AT,
          pidCanStillOwnRun: (pid) => alive.includes(pid),
          runtimeAbsent: () => Promise.resolve(true),
          terminalState: "stopped",
        });
      expect(await reconcileB([APP_SERVER])).toMatchObject({
        reason: expect.stringContaining("codexAppServerPid pid 7000"),
        status: "refused",
      });
      // Another run's state unreadable: the app-server is B's own explicit
      // record, which only another run's walk could name too, so B's
      // cleanup still ends it.
      const c = join(storage, "repo-shared", "3");
      mkdirSync(c, { recursive: true });
      writeFileSync(join(c, "manifest.json"), "{ torn");
      expect(readOtherRunIndex(b.runDir, [storage])).toMatchObject({
        kind: "unknown",
      });
      cleanupRunOwnedProcesses(b.runDir, readRunManifest(b.manifestPath));
      expect(signals).toEqual(["-7000:SIGTERM", "-7000:SIGTERM"]);
      rmSync(c, { force: true, recursive: true });
      expect(await reconcileB([])).toMatchObject({ status: "changed" });
    }
  );
});

test("this run's own tmux socket on a command line never makes a process shared with another run on the same tmux server", async () => {
  const SOCKET = "/private/tmp/tmux-501/default";
  await withTwoRuns("working", { tmuxSocket: SOCKET }, ({ a, b, storage }) => {
    writeRunManifest(a.manifestPath, {
      ...(readRunManifest(a.manifestPath) as RunManifest),
      tmuxSocket: SOCKET,
    });
    const other = {
      runDir: b.runDir,
      runId: "2",
      session: "repo-shared-loop-2",
      socket: SOCKET,
    };
    const command = `tmux -S ${SOCKET} capture-pane -p -t repo-shared-loop-1:0`;
    expect(
      commandNamesRun(command, other, {
        runId: "1",
        session: "repo-shared-loop-1",
        socket: SOCKET,
      })
    ).toBeUndefined();
    // A socket that is not this run's still names the other run.
    expect(commandNamesRun(command, other, { runId: "1" })).toBe("tmux socket");
    recordWalkedGroup(a.runDir, 7100);
    const table = [row(PANE, 1, PANE), row(7100, PANE, 7100)];
    const probes = fakeProbes(
      storage,
      table,
      { 7100: a.workspace },
      { 7100: command }
    );
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups?.map((target) => target.id)).toEqual([PANE, 7100]);
    expect(collected.skipped).toEqual([]);
    expect(
      sharedTargetCheck(
        a.runDir,
        () => readRunManifest(a.manifestPath),
        probes
      )([inferredTarget(7100)]).size
    ).toBe(0);
  });
});

test("a walked group whose ancestor's command line names live B's run directory (B's tmux proxy, say) is shared, though nothing records either", async () => {
  await withTwoRuns("working", {}, async ({ a, b, storage }) => {
    const PROXY = 7860;
    const CHILD = 7861;
    recordWalkedGroup(a.runDir, CHILD);
    const table = [
      row(PANE, 1, PANE),
      row(PROXY, 1, PROXY),
      row(CHILD, PROXY, CHILD),
    ];
    const probes = fakeProbes(
      storage,
      table,
      { [CHILD]: a.workspace, [PROXY]: a.workspace },
      { [PROXY]: `loop __codex-tmux-proxy ${b.runDir} %2` }
    );
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.skipped).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining(
          `ancestor pid ${PROXY}'s command names run 2's run directory`
        ),
        otherRunId: "2",
        pid: CHILD,
        reason: "shared-process-skipped",
      })
    );
    const signals: string[] = [];
    await terminateTargets(
      [inferredTarget(CHILD)],
      fakeTermination(signals, {
        sharedSkips: sharedTargetCheck(
          a.runDir,
          () => readRunManifest(a.manifestPath),
          probes
        ),
      })
    );
    expect(signals).toEqual([]);
  });
});

test("the ancestor walk stops at this run's pane processes: the shared tmux server above them, started by another run's session, never makes this run's tool groups shared", async () => {
  await withTwoRuns("working", {}, ({ a, storage }) => {
    const SERVER = 400;
    recordWalkedGroup(a.runDir, 7150);
    const table = [
      row(SERVER, 1, SERVER),
      row(PANE, SERVER, PANE),
      row(601, PANE, 601),
      row(7150, 601, 7150),
    ];
    const probes = fakeProbes(
      storage,
      table,
      { 7150: a.workspace },
      { [SERVER]: "tmux new-session -d -s repo-shared-loop-2" }
    );
    useCleanupProbes(probes);
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups?.map((target) => target.id)).toContain(7150);
    expect(collected.skipped).toEqual([]);
    expect(
      sharedTargetCheck(
        a.runDir,
        () => readRunManifest(a.manifestPath),
        probes
      )([inferredTarget(7150)]).size
    ).toBe(0);
  });
});

test("after the run's panes end, a live walked group working outside the workspace stops counting only if a snapshot saw it re-parented while its pane lived; a group the teardown targeted and could not end still blocks", async () => {
  await withTwoRuns("working", {}, async ({ a, storage }) => {
    const GROUP = 7450;
    recordWalkedGroup(a.runDir, GROUP);
    // The teardown's collection, while the pane lives and the group hangs
    // off it: a target (run-owned), and never marked re-parented.
    const live = [
      row(PANE, 1, PANE),
      row(601, PANE, 601),
      row(GROUP, 601, GROUP),
    ];
    useCleanupProbes(
      fakeProbes(storage, live, { [GROUP]: "/Users/someone/.cache" })
    );
    const collected = collectRunAgentGroups(
      a.runDir,
      readRunManifest(a.manifestPath)
    );
    expect(collected.groups?.map((target) => target.id)).toContain(GROUP);
    expect(
      readAgentGroupRecords(a.runDir).find((record) => record.pgid === GROUP)
        ?.reparentedAt
    ).toBeUndefined();
    // The kill did not end it (EPERM, or it survived SIGKILL's wait); the
    // pane is gone and the group re-parented to launchd.
    const gone = [row(GROUP, 1, GROUP)];
    const reconcile = () =>
      reconcileA(
        a.manifestPath,
        recordedProcessClassifier(
          fakeProbes(storage, gone, { [GROUP]: "/Users/someone/.cache" })
        ),
        [GROUP]
      );
    expect(await reconcile()).toMatchObject({
      reason: expect.stringContaining(`agent-group-${GROUP}.json`),
      status: "refused",
    });
    // A snapshot without the pane cannot tell a daemon from an orphan.
    recordAgentDescendantGroups({
      groupAlive: () => true,
      now: () => SNAPSHOT_AT,
      runDir: a.runDir,
      table: gone,
    });
    expect(await reconcile()).toMatchObject({ status: "refused" });
    // Nor can a snapshot whose table hangs the group off a process that is
    // neither the run's nor launchd, even while the pane lives.
    recordAgentDescendantGroups({
      groupAlive: () => true,
      now: () => SNAPSHOT_AT,
      runDir: a.runDir,
      table: [row(PANE, 1, PANE), row(4444, 1, 4444), row(GROUP, 4444, GROUP)],
    });
    expect(
      readAgentGroupRecords(a.runDir).find((record) => record.pgid === GROUP)
        ?.reparentedAt
    ).toBeUndefined();
    expect(await reconcile()).toMatchObject({ status: "refused" });
    // A snapshot while the pane lived saw it re-parented to launchd: a
    // daemon that left the run; outside the workspace it does not count.
    recordAgentDescendantGroups({
      groupAlive: () => true,
      now: () => SNAPSHOT_AT,
      runDir: a.runDir,
      table: [row(PANE, 1, PANE), row(GROUP, 1, GROUP)],
    });
    expect(
      readAgentGroupRecords(a.runDir).find((record) => record.pgid === GROUP)
        ?.reparentedAt
    ).toBe(SNAPSHOT_AT);
    expect(await reconcile()).toMatchObject({ status: "changed" });
  });
});

test("this file's HOME is an isolated empty directory, so the default probes never read the machine's own runs", () => {
  expect(isolatedHome).not.toBe("");
  expect(defaultStorageRoots("/tmp/loop-run-x")).toEqual([
    join(isolatedHome, ".loop", "runs"),
  ]);
});

// --- (d) Utility workers re-verified before every signal ------------------------

const workerCommand = (runDir: string, epoch: number, jobId: string) =>
  `/Users/me/.local/bin/loop ${UTILITY_WORKER_SUBCOMMAND} ${runDir} ${epoch} ${jobId}`;

test("a utility worker target is re-verified right before every signal round: its command while the leader lives, and its start against the identification instant", () => {
  const identity = { epoch: 1, jobId: "job-a", runDir: "/runs/r/1" };
  const target: TerminationTarget = {
    id: 5101,
    identity,
    kind: "group",
    reference: SNAPSHOT_AT,
    source: "utility job job-a worker",
  };
  const live = [row(5101, 1, 5101), row(5111, 5101, 5101)];
  expect(
    stillRecordedOn([target], live, () =>
      workerCommand("/runs/r/1", 1, "job-a")
    )
  ).toEqual(new Set(["group:5101"]));
  // The leader now runs something else: never signalled.
  expect(stillRecordedOn([target], live, () => "/usr/bin/vim notes")).toEqual(
    new Set()
  );
  expect(
    stillRecordedOn([target], live, () =>
      workerCommand("/runs/r/1", 2, "job-a")
    )
  ).toEqual(new Set());
  expect(stillRecordedOn([target], live, () => undefined)).toEqual(new Set());
  // The leader exited on the first SIGTERM; its bounded command remains,
  // started before the identification: still the worker's group.
  expect(
    stillRecordedOn([target], [row(5111, 1, 5101)], () => undefined)
  ).toEqual(new Set(["group:5101"]));
  // The id was reused after the identification: never signalled.
  expect(
    stillRecordedOn([target], [row(5101, 1, 5101, AFTER)], () =>
      workerCommand("/runs/r/1", 1, "job-a")
    )
  ).toEqual(new Set());
});

test("termination re-verifies a utility worker before SIGKILL: one whose pid now runs another command is reported unverified and never killed", async () => {
  const signals: string[] = [];
  let command = workerCommand("/runs/r/1", 1, "job-a");
  const target: TerminationTarget = {
    id: 5101,
    identity: { epoch: 1, jobId: "job-a", runDir: "/runs/r/1" },
    kind: "group",
    reference: SNAPSHOT_AT,
    source: "utility job job-a worker",
  };
  const ended = await terminateTargets(
    [target],
    fakeTermination(signals, {
      signal: (id, signal) => {
        signals.push(`${id}:${signal}`);
        // The worker exits on SIGTERM and its pid is reused at once by a
        // process that started before the reference second (same second).
        command = "/usr/bin/python3 server.py";
      },
      stillRecorded: (targets) =>
        stillRecordedOn(targets, [row(5101, 1, 5101)], () => command),
    })
  );
  expect(signals).toEqual(["-5101:SIGTERM"]);
  expect(ended.unverified).toEqual([
    "utility job job-a worker process group 5101",
  ]);
  expect(ended.killed).toEqual([]);
});

test("each signal round judges identity and sharing on ONE process snapshot, and the SIGKILL round takes a new one", async () => {
  const signals: string[] = [];
  const taken: ProcessSnapshot[] = [];
  const seen: [string, ProcessSnapshot | undefined][] = [];
  const ended = await terminateTargets(
    [{ id: 5201, kind: "group", reference: SNAPSHOT_AT, source: "pane" }],
    fakeTermination(signals, {
      sharedSkips: (_targets, snapshot) => {
        seen.push(["shared", snapshot]);
        return new Map();
      },
      snapshot: () => {
        const snapshot: ProcessSnapshot = {
          commands: () => new Map(),
          table: [row(5201, 1, 5201)],
        };
        taken.push(snapshot);
        return snapshot;
      },
      stillRecorded: (targets, snapshot) => {
        seen.push(["identity", snapshot]);
        return new Set(targets.map((target) => `${target.kind}:${target.id}`));
      },
    })
  );
  expect(signals).toEqual(["-5201:SIGTERM", "-5201:SIGKILL"]);
  expect(ended.killed).toEqual(["pane process group 5201"]);
  expect(taken).toHaveLength(2);
  expect(seen).toEqual([
    ["identity", taken[0]],
    ["shared", taken[0]],
    ["identity", taken[1]],
    ["shared", taken[1]],
  ]);
});

test("the production checks read the round's snapshot, not tables of their own", () => {
  const forbidden = (): never => {
    throw new Error("a check read its own table");
  };
  const snapshot: ProcessSnapshot = {
    commands: () => new Map([[5301, workerCommand("/runs/r/1", 1, "job-a")]]),
    table: [row(5301, 1, 5301)],
  };
  const worker: TerminationTarget = {
    id: 5301,
    identity: { epoch: 1, jobId: "job-a", runDir: "/runs/r/1" },
    kind: "group",
    reference: SNAPSHOT_AT,
    source: "utility job job-a worker",
  };
  expect(defaultStillRecorded([worker], snapshot)).toEqual(
    new Set(["group:5301"])
  );
  // The identity re-check reads the snapshot's command line: a leader that
  // runs another command in that snapshot is not the worker.
  expect(
    defaultStillRecorded([worker], {
      ...snapshot,
      commands: () => new Map([[5301, "/usr/bin/vim notes.txt"]]),
    })
  ).toEqual(new Set());
  const check = sharedTargetCheck("/nonexistent/run", () => undefined, {
    commandTable: forbidden,
    cwdOfPid: forbidden,
    otherRunIndex: (_runDir, table) => {
      expect(table).toBe(snapshot.table);
      return { kind: "read", references: [], runs: [] };
    },
    processTable: forbidden,
  });
  expect(check([inferredTarget(5301)], snapshot).size).toBe(0);
  expect(defaultTerminationDeps().snapshot).toBeDefined();
});

// --- The governess logs every shared skip ---------------------------------------

test("the teardown logs shared-process-skipped with the other run's id at collection and at termination", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-shared-log-"));
  try {
    const logged: Record<string, unknown>[] = [];
    const config = {
      epoch: 1,
      logFile: join(root, "governess.jsonl"),
      runDir: root,
      session: "repo-shared-loop-1",
    } as unknown as GovernessConfig;
    await stopGovernessLoop(
      config,
      {
        appendLog: (_file: string, record: unknown) => {
          logged.push(record as Record<string, unknown>);
        },
        cleanupRunProcesses: () => ({
          killed: [],
          skipped: [
            {
              detail: "codexAppServerPid: recorded by run 3",
              otherRunId: "3",
              pid: 7600,
              reason: "shared-process-skipped",
            },
          ],
        }),
        collectAgentGroups: () => ({
          groups: [inferredTarget(7700)],
          killed: [],
          skipped: [
            {
              detail: "agent %1 descendant: recorded by run 2",
              otherRunId: "2",
              pid: APP_SERVER,
              reason: "shared-process-skipped",
            },
          ],
        }),
        fenceCurrent: () => true,
        killSession: () => undefined,
        now: () => at(SNAPSHOT_AT),
        terminateRunProcessGroups: () =>
          Promise.resolve({
            exited: [],
            failed: [],
            killed: [],
            shared: [
              {
                detail: "recorded by run 4",
                otherRunId: "4",
                reason: "shared-process-skipped" as const,
                target: "agent %1 descendant process group 7700",
              },
            ],
            survivors: [],
          }),
      } as unknown as GovernessDeps,
      "test teardown"
    );
    expect(
      logged
        .filter((record) => record.event === "shared-process-skipped")
        .map((record) => [
          record.phase,
          record.otherRunId,
          record.pid ?? record.target,
        ])
    ).toEqual([
      ["cleanup", "3", 7600],
      ["collect", "2", APP_SERVER],
      ["terminate", "4", "agent %1 descendant process group 7700"],
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- Real processes -------------------------------------------------------------

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

const waitFor = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

/**
 * A stub "app-server" started the way B's launcher (run from A's tool shell)
 * starts it: a child of a shell, in a session and group of its own, that
 * outlives the shell. Returns the shell's pid and the stub's pid.
 */
const startStubAppServer = async (
  cwd: string
): Promise<{ shell: ReturnType<typeof spawn>; stub: number }> => {
  const shell = spawn(
    [
      "/bin/sh",
      "-c",
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die; $0 = "stub codex app-server --listen ws://127.0.0.1:0"; sleep 60' & echo $!; wait`,
    ],
    { cwd, detached: true, stderr: "ignore", stdin: "ignore", stdout: "pipe" }
  );
  const stub = Number.parseInt(await readLine(shell.stdout), 10);
  return { shell, stub };
};

test("real: the launch auto-release of dead run A does not wait on the app-server live B records, and the new launch proceeds", async () => {
  await withTwoRuns("working", {}, async ({ a, b, storage }) => {
    const { shell, stub } = await startStubAppServer(b.workspace);
    try {
      expect(await waitFor(() => processGroupAlive(stub))).toBe(true);
      const later = new Date(Date.now() + 2000).toISOString();
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        codexAppServerPid: stub,
        updatedAt: later,
      });
      mkdirSync(join(a.runDir, "run-processes"), { recursive: true });
      writeFileSync(
        join(a.runDir, "run-processes", `agent-group-${stub}.json`),
        `${JSON.stringify({
          kind: "agent-descendant-group",
          paneId: "%1",
          pgid: stub,
          recordedAt: later,
          runDir: a.runDir,
        })}\n`
      );
      const binding = readRunManifest(a.manifestPath)
        ?.workspaceBinding as LaunchWorkspaceBinding;
      const logs: string[] = [];
      // Production probes and classifier (the reservation's defaults); only
      // the tmux facts are faked: A's session is gone.
      const claim = await reservePairedLaunch(
        {
          agent: "claude",
          pairWith: "codex",
          pairedMode: true,
          tmux: true,
        } as Options,
        binding,
        {
          endpointState: () => "absent",
          env: { LOOP_TMUX_SOCKET: "/tmp/ls-shared-test/launch.sock" },
          home: join(storage, "..", ".."),
          log: (line) => {
            logs.push(line);
          },
          makeClaimId: () => "claim-shared",
          now: () => new Date().toISOString(),
          tmuxLiveness: () => "unknown",
          uid: 501,
        }
      );
      expect(claim).toMatchObject({ reserved: true });
      expect(readRunManifest(a.manifestPath)?.workspaceReleasedAt).toEqual(
        expect.any(String)
      );
      expect(logs.join("\n")).toContain("released workspace of dead run 1 ");
      expect(processGroupAlive(stub)).toBe(true);
    } finally {
      killGroup(shell.pid);
      killGroup(stub);
    }
  });
});

test("real: the governess's production termination and handback (its default deps) skip the group live B records and release A", async () => {
  await withTwoRuns("working", {}, async ({ a, b }) => {
    const { shell, stub } = await startStubAppServer(b.workspace);
    try {
      expect(await waitFor(() => processGroupAlive(stub))).toBe(true);
      const later = new Date(Date.now() + 2000).toISOString();
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        codexAppServerPid: stub,
        updatedAt: later,
      });
      mkdirSync(join(a.runDir, "run-processes"), { recursive: true });
      writeFileSync(
        join(a.runDir, "run-processes", `agent-group-${stub}.json`),
        `${JSON.stringify({
          kind: "agent-descendant-group",
          paneId: "%1",
          pgid: stub,
          recordedAt: later,
          runDir: a.runDir,
        })}\n`
      );
      const config = {
        manifestPath: a.manifestPath,
        runDir: a.runDir,
        runId: "1",
      } as unknown as GovernessConfig;
      const deps = defaultGovernessDeps();
      const ended = await deps.terminateRunProcessGroups?.(config, [
        {
          id: stub,
          kind: "group",
          ownership: "inferred",
          reference: later,
          source: "agent %1 descendant",
        },
      ]);
      expect(ended?.shared).toMatchObject([
        { otherRunId: "2", reason: "shared-process-skipped" },
      ]);
      expect(processGroupAlive(stub)).toBe(true);
      // The handback probes the run's own recorded socket, which no server
      // listens on here, so the runtime is absent.
      const released = await deps.releaseWorkspaceAfterTeardown?.(config);
      expect(released).toMatchObject({ released: true });
      expect(released?.detail).toContain(
        `not counted: run-processes/agent-group-${stub}.json pid ${stub} (shared-process-skipped`
      );
      expect(processGroupAlive(stub)).toBe(true);
    } finally {
      killGroup(shell.pid);
      killGroup(stub);
    }
  });
});

test("real: A's teardown leaves the app-server live B records running and releases; once B is dead, A ends it", async () => {
  await withTwoRuns("working", {}, async ({ a, b }) => {
    const { shell, stub } = await startStubAppServer(b.workspace);
    try {
      expect(await waitFor(() => processGroupAlive(stub))).toBe(true);
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        codexAppServerPid: stub,
        updatedAt: new Date(Date.now() + 2000).toISOString(),
      });
      // A's walk saw the stub while the shell (standing in for A's pane CLI
      // and B's launcher) was its parent.
      recordRunPaneProcesses({
        agentPaneIds: ["%1"],
        now: () => new Date(Date.now() + 2000).toISOString(),
        panes: [{ paneId: "%1", pid: shell.pid }],
        runDir: a.runDir,
        session: "repo-shared-loop-1",
      });
      runProcessCleanupInternals.deps.listRunPanes = () => undefined;
      const first = collectRunAgentGroups(
        a.runDir,
        readRunManifest(a.manifestPath)
      );
      expect(first.skipped).toContainEqual(
        expect.objectContaining({
          otherRunId: "2",
          pid: stub,
          reason: "shared-process-skipped",
        })
      );
      // The production termination, with A's pre-signal shared check, on a
      // target for the stub (as if collected before B recorded it).
      const sharedSkips = sharedTargetCheck(a.runDir, () =>
        readRunManifest(a.manifestPath)
      );
      const ended = await terminateTargets(
        [
          {
            id: stub,
            kind: "group",
            ownership: "inferred",
            reference: new Date(Date.now() + 2000).toISOString(),
            source: "agent %1 descendant",
          },
        ],
        { ...defaultTerminationDeps(), graceMs: 300, sharedSkips }
      );
      expect(ended.shared).toMatchObject([
        { otherRunId: "2", reason: "shared-process-skipped" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(processGroupAlive(stub)).toBe(true);
      // A releases: the stub is live but B's, working in B's workspace.
      killGroup(shell.pid);
      await shell.exited;
      const release = await reconcileLegacyStoppedRun(a.manifestPath, "1", {
        classifyRecordedProcess: recordedProcessClassifier(
          defaultOwnershipProbes
        ),
        now: () => new Date().toISOString(),
        pidCanStillOwnRun: () => false,
        groupCanStillOwnRun: (pgid) => processGroupAlive(pgid),
        runtimeAbsent: () => Promise.resolve(true),
        terminalState: "stopped",
      });
      expect(release).toMatchObject({ status: "changed" });
      expect(processGroupAlive(stub)).toBe(true);
      // B's manifest turns terminal while the app-server it records still
      // lives: a terminal manifest alone does not make B dead, so the stub is
      // still B's and A's teardown leaves it alone.
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        state: "stopped",
        status: "stopped",
      });
      const terminalOnly = await terminateTargets(
        [
          {
            id: stub,
            kind: "group",
            ownership: "inferred",
            reference: new Date(Date.now() + 2000).toISOString(),
            source: "agent %1 descendant",
          },
        ],
        { ...defaultTerminationDeps(), graceMs: 300, sharedSkips }
      );
      expect(terminalOnly.shared).toMatchObject([
        { otherRunId: "2", reason: "shared-process-skipped" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(processGroupAlive(stub)).toBe(true);
      // B is provably dead: terminal, nothing it records is live, and its
      // tmux runtime is gone (its recorded socket has no server; the
      // production probe asks that socket only). A (resumed and torn down
      // again, or any later teardown that records the stub) may now end it.
      writeRunManifest(b.manifestPath, {
        ...(readRunManifest(b.manifestPath) as RunManifest),
        codexAppServerPid: undefined,
      });
      const later = await terminateTargets(
        [
          {
            id: stub,
            kind: "group",
            ownership: "inferred",
            reference: new Date(Date.now() + 2000).toISOString(),
            source: "agent %1 descendant",
          },
        ],
        { ...defaultTerminationDeps(), graceMs: 300, sharedSkips }
      );
      expect(later.shared).toBeUndefined();
      expect(await waitFor(() => !processGroupAlive(stub))).toBe(true);
    } finally {
      killGroup(shell.pid);
      killGroup(stub);
    }
  });
});

test("real: a utility worker target whose pid runs another command is never signalled; the worker itself is", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-shared-worker-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  const script = join(root, "worker.pl");
  writeFileSync(script, "sleep 60;\n");
  chmodSync(script, 0o755);
  const worker = spawn(
    ["/usr/bin/perl", script, UTILITY_WORKER_SUBCOMMAND, runDir, "1", "job-a"],
    { detached: true, stderr: "ignore", stdin: "ignore", stdout: "ignore" }
  );
  const other = spawn(["/usr/bin/perl", script, "not-a-worker"], {
    detached: true,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reference = new Date(Date.now() + 1000).toISOString();
    const identity = { epoch: 1, jobId: "job-a", runDir };
    const ended = await terminateTargets(
      [
        {
          id: other.pid,
          identity,
          kind: "group",
          reference,
          source: "utility job job-a worker (pid reused)",
        },
        {
          id: worker.pid,
          identity,
          kind: "group",
          reference,
          source: "utility job job-a worker",
        },
      ],
      { ...defaultTerminationDeps(), graceMs: 300 }
    );
    expect(ended.unverified).toEqual([
      `utility job job-a worker (pid reused) process group ${other.pid}`,
    ]);
    expect(processGroupAlive(other.pid)).toBe(true);
    expect(await waitFor(() => !processGroupAlive(worker.pid))).toBe(true);
  } finally {
    killGroup(worker.pid);
    killGroup(other.pid);
    rmSync(root, { force: true, recursive: true });
  }
});

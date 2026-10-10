// A teardown must not leave a helper running in the workspace it hands back.
//
// 1. The operator's teardown arrives through the interaction intake, which
//    calls `stopGovernessLoop` without awaiting it, in the middle of a
//    governess cycle. The rest of that cycle routes helper requests, which
//    can spawn a detached utility worker. The first test drives the real
//    governess loop through that path: nothing is routed or granted after
//    the teardown began, and the loop ends only once the teardown's release
//    attempt is done.
// 2. The second test runs a teardown with the PRODUCTION cleanup, session
//    kill, and release wiring of `defaultGovernessDeps` (nothing of it is
//    injected), against real child processes standing in for the run's
//    detached bridge and utility workers. No live tmux server is contacted:
//    `TMUX_TMPDIR` points at an empty scratch directory for the kill, and the
//    run's recorded socket does not exist.

import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import {
  defaultGovernessDeps,
  type GovernessConfig,
  type GovernessDeps,
  runGoverness,
  stopGovernessLoop,
  teardownHangupInternals,
} from "../../src/loop/governess";
import { teardownRequestId } from "../../src/loop/governess-interaction-intake";
import {
  appendNativeFallbackRequest,
  createNativeFallbackRequest,
  readNativeFallbackRequests,
} from "../../src/loop/native-subagent";
import {
  createRunManifest,
  readRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import { UTILITY_WORKER_SUBCOMMAND } from "../../src/loop/utility-constants";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const START_MS = 1_000_000;
const REASON = "operator ended the run from the phone";

const originalHangup = { ...teardownHangupInternals };

afterEach(() => {
  Object.assign(teardownHangupInternals, originalHangup, {
    state: { armed: false, hungUp: false, settled: false },
  });
});

interface Spies {
  events: string[];
  kills: string[];
  logs: Record<string, unknown>[];
  stops: string[];
}

const loopDeps = (spies: Spies): GovernessDeps => ({
  appendLog: (_file, record) => {
    spies.logs.push(record as Record<string, unknown>);
    spies.events.push(String((record as { event?: unknown }).event));
  },
  assessRoleBalance: () =>
    Promise.resolve({
      confidence: 0,
      reason: "",
      switchDriver: false,
      tokens: 0,
    }),
  assessWaiting: () => Promise.resolve({ ask: "", tokens: 0, waiting: false }),
  capturePane: () => "stable pane text",
  cleanupRunProcesses: () => {
    spies.events.push("cleanup");
    return { killed: [], skipped: [] };
  },
  fenceCurrent: () => true,
  initPaneBorders: () => undefined,
  judge: () =>
    Promise.resolve({
      ok: true,
      verdict: { confidence: 0.9, state: "working", summary: "" },
    }),
  killSession: (session) => {
    spies.kills.push(session);
    spies.events.push("kill");
  },
  labelPanes: () => Promise.resolve({ labels: {}, tokens: 0 }),
  loadState: () => undefined,
  markRunStopped: (_config, reason) => {
    spies.stops.push(reason);
  },
  notify: () => undefined,
  now: () => START_MS,
  readBridge: () => ({}),
  readBridgeLatest: () => ({}),
  readHooks: () => [],
  readHumanMessages: () => [],
  readLocalLlmRuntime: () => ({}),
  readUsage: () => ({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    compactedContextTokens: 0,
    compactions: 0,
    contextRateTokensPerMinute: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    costRateUsdPerHour: 0,
    costUsd: 0,
    dataConfidence: "exact",
    humanMessages: 0,
    inputTokens: 0,
    messages: 0,
    outputTokens: 0,
    textMessages: 0,
    thinkingMessages: 0,
    toolCallCounts: {},
    toolCalls: 0,
    totalTokens: 0,
  }),
  readUsageLimits: () => Promise.resolve(undefined),
  recordAgentDescendants: () => {
    spies.events.push("record-agent-descendants");
  },
  // The release finishes on a later timer turn, so a loop that did not await
  // the teardown would return before it.
  releaseWorkspaceAfterTeardown: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    spies.events.push("release-attempt");
    return { detail: "changed", released: true };
  },
  render: () => undefined,
  replacementSessionReady: () => false,
  respawnPane: () => undefined,
  saveState: () => undefined,
  sendBridge: () => Promise.resolve("accepted"),
  sendKeys: () => undefined,
  sendText: () => undefined,
  setGovernessPaneIdentity: () => undefined,
  setPaneLabel: () => undefined,
  sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
  summarize: () => Promise.resolve({ text: "", tokens: 0 }),
});

test("an intake teardown routes no helper for the rest of its cycle and ends the loop once its release is done", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-teardown-gate-"));
  const repoRoot = join(root, "repo");
  const runDir = join(root, "runs", "repo-1", "90");
  try {
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(runDir, "interaction-actions"), { recursive: true });
    const manifestPath = join(runDir, "manifest.json");
    writeRunManifest(
      manifestPath,
      createRunManifest({
        cwd: repoRoot,
        mode: "paired",
        pid: 90_001,
        repoId: "repo-1",
        runId: "90",
        state: "working",
      })
    );
    // The operator's teardown, as the control surface records it.
    const key = "b".repeat(64);
    const request = {
      idempotencyKeyHash: key,
      kind: "lifecycle-teardown",
      reason: REASON,
      repoId: "repo-1",
      requestId: teardownRequestId("repo-1", "90", key),
      runId: "90",
      submittedAt: "2026-10-06T11:00:00.000Z",
      version: "1",
    };
    writeFileSync(
      join(runDir, "interaction-actions", "events.jsonl"),
      `${JSON.stringify({ at: request.submittedAt, eventId: `requested:${request.requestId}`, request, requestId: request.requestId, type: "requested", version: "1" })}\n`
    );
    // Helper work waiting in the same cycle.
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["return an explicit verdict"],
        authority: {},
        createdAt: "2026-10-06T11:00:00.000Z",
        id: "late-review",
        kind: "review",
        objective: "Review the last change",
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
    appendNativeFallbackRequest(
      runDir,
      createNativeFallbackRequest({
        acceptanceCriteria: ["return independent file-backed findings"],
        evidenceTaskIds: ["late-review"],
        fallbackReason: "independent-review",
        id: "late-native",
        kind: "review",
        objective: "Independently review the last change",
        readScope: ["src"],
        requester: "claude",
      })
    );

    const spies: Spies = { events: [], kills: [], logs: [], stops: [] };
    const deps = loopDeps(spies);
    // Were the loop to keep going after the teardown, these keys would tear
    // it down a second time through the exit menu.
    const keys = ["x", "e"];
    let keyReads = 0;
    deps.openKeyInput = () => ({
      close: () => undefined,
      next: () => {
        keyReads += 1;
        return keys.length > 0
          ? new Promise<string>((resolve) =>
              setTimeout(() => resolve(keys.shift() ?? ""), 50)
            )
          : new Promise<string>(() => undefined);
      },
    });
    const config = {
      agentRenameEnabled: false,
      agents: [
        {
          agent: "claude",
          hookFile: join(root, "claude.jsonl"),
          pane: "s:0.0",
        },
        { agent: "codex", hookFile: join(root, "codex.jsonl"), pane: "s:0.1" },
      ],
      budgetUsd: 0,
      confidence: 0.7,
      cooldownMs: 300_000,
      cwd: repoRoot,
      driverEffort: "medium",
      dryRun: false,
      epoch: 1,
      escalateIdleMs: 300_000,
      idleMs: 60_000,
      initialDriver: "claude",
      judgeMode: "consensus",
      llmDecodeConcurrency: 32,
      llmPrefillStepSize: 2048,
      llmPromptCacheSlots: 10,
      llmPromptConcurrency: 8,
      logFile: join(root, "governess.jsonl"),
      manifestPath,
      maxRecoveries: 3,
      model: "m",
      reviewerEffort: "medium",
      roleBalanceEnabled: false,
      runDir,
      runId: "90",
      session: "repo-loop-90",
      tickMs: 15_000,
      url: "http://127.0.0.1:8082",
      usageTrackerTimeoutMs: 1500,
    } as unknown as GovernessConfig;

    await runGoverness(config, deps);

    // The teardown ran once, through the intake, and its release attempt was
    // done before the loop returned.
    expect(spies.stops).toEqual([REASON]);
    expect(spies.kills).toEqual(["repo-loop-90"]);
    // The cycle recorded the agent CLIs' descendant groups before its intake
    // began the teardown, and never after.
    const head = spies.events.slice(0, spies.events.indexOf("exit"));
    expect(head).toContain("record-agent-descendants");
    const tail = spies.events.slice(spies.events.indexOf("exit"));
    expect(tail).toEqual([
      "exit",
      "cleanup",
      "kill",
      "interaction-actions-processed",
      "helper-routing-skipped",
      "release-attempt",
      "workspace-released",
    ]);
    // Nothing waiting was routed or granted after the teardown began.
    expect(readUtilityJob(runDir, "late-review")?.state).toBe("pending-route");
    expect(
      readNativeFallbackRequests(runDir).find(
        (snapshot) => snapshot.request.id === "late-native"
      )?.state
    ).toBe("pending");
    expect(spies.events).not.toContain("utility-routes-processed");
    expect(spies.events).not.toContain("native-fallback-requests-processed");
    // The loop ended with the teardown, not through the exit menu.
    expect(keyReads).toBe(1);
    expect(keys).toEqual(["x", "e"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 20_000);

// --- Production wiring --------------------------------------------------------

const SLEEPER = `
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`;

const deadPid = (): number => {
  const result = spawnSync("/usr/bin/true");
  if (typeof result.pid !== "number") {
    throw new Error("could not spawn a short-lived process");
  }
  return result.pid;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Polls until `pid` is gone; a SIGTERMed child needs a moment to exit. */
const exited = async (pid: number, withinMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};

// The production kill runs the `tmux` binary. Without it on PATH the kill is
// reported unconfirmed (`tmux control unavailable`), and by design no release
// is attempted after an unconfirmed kill, so this wiring cannot be observed.
const TMUX_ON_PATH = Boolean(which("tmux"));
if (!TMUX_ON_PATH) {
  console.warn(
    "[teardown-helper-gate] skipping the production wiring test: no tmux binary on PATH, so the production session kill cannot be confirmed"
  );
}
const productionWiringTest = TMUX_ON_PATH ? test : test.skip;

productionWiringTest(
  "the production teardown wiring ends the run's detached workers and hands the workspace back",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-teardown-wiring-"));
    // Short, and never created: the run's recorded tmux server is gone.
    const socketDir = `/tmp/loop-wiring-${process.pid}-${Date.now()}`;
    const tmuxTmp = mkdtempSync(join(tmpdir(), "loop-wiring-tmux-"));
    const runDir = join(root, "runs", "repo-1", "91");
    const repoRoot = join(root, "repo");
    const children: number[] = [];
    const savedEnv = {
      LOOP_TMUX_SOCKET: process.env.LOOP_TMUX_SOCKET,
      TMUX: process.env.TMUX,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    };
    try {
      // The kill goes to an empty scratch tmux directory, never a live server.
      process.env.TMUX_TMPDIR = tmuxTmp;
      Reflect.deleteProperty(process.env, "TMUX");
      Reflect.deleteProperty(process.env, "LOOP_TMUX_SOCKET");
      teardownHangupInternals.onHangup = () => undefined;
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(runDir, { recursive: true });
      const sleeper = join(root, "sleeper.ts");
      writeFileSync(sleeper, SLEEPER);
      const start = (args: string[], detached: boolean): number => {
        const child = spawn(process.execPath, [sleeper, ...args], {
          detached,
          stdio: "ignore",
        });
        child.unref();
        if (typeof child.pid !== "number") {
          throw new Error("could not spawn a worker stand-in");
        }
        children.push(child.pid);
        return child.pid;
      };
      const bridgeWorker = start(["__bridge-worker", runDir], false);
      const utilityWorker = start(
        [UTILITY_WORKER_SUBCOMMAND, runDir, "1", "job-w"],
        true
      );
      // Give both a moment to exec so `ps` shows their final command lines.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const manifestPath = join(runDir, "manifest.json");
      writeRunManifest(manifestPath, {
        ...createRunManifest({
          cwd: repoRoot,
          mode: "paired",
          pid: deadPid(),
          repoId: "repo-1",
          runId: "91",
          state: "working",
          tmuxSession: "repo-loop-91",
          workspaceBinding: {
            branchRef: "refs/heads/main",
            repoId: "repo-1",
            root: repoRoot,
          },
        }),
        tmuxSocket: `${socketDir}/default`,
      });
      writeFileSync(
        join(runDir, "bridge-worker.json"),
        `${JSON.stringify({ pid: bridgeWorker })}\n`
      );
      appendUtilityRouteRequest(
        runDir,
        createUtilityRouteRequest({
          acceptanceCriteria: ["return source-backed evidence"],
          authority: {},
          id: "job-w",
          kind: "inspect",
          objective: "Inspect the worker configuration",
          readScope: ["src"],
          requester: "claude",
          requiredCapabilities: ["inspect"],
          risk: "low",
          writeScope: [],
        })
      );
      activateUtilityEpoch(runDir, 1);
      transitionUtilityJob(runDir, "job-w", "routed-utility", {
        decision: {
          reason: "utility-eligible",
          target: "utility",
          tierId: "utility-au-pair",
        },
        routeEpoch: 1,
      });
      claimUtilityJob(runDir, 1, {
        jobId: "job-w",
        workerId: `utility-${utilityWorker}`,
        workerPid: utilityWorker,
      });
      transitionUtilityJob(runDir, "job-w", "running", {});
      expect(alive(bridgeWorker)).toBe(true);
      expect(alive(utilityWorker)).toBe(true);

      const events: string[] = [];
      const production = defaultGovernessDeps();
      await stopGovernessLoop(
        {
          agents: [],
          epoch: 1,
          logFile: join(root, "governess.jsonl"),
          manifestPath,
          runDir,
          runId: "91",
          session: "repo-loop-91",
        } as unknown as GovernessConfig,
        {
          ...production,
          appendLog: (_file, record) => {
            events.push(JSON.stringify(record));
          },
          fenceCurrent: () => true,
        },
        "user requested teardown"
      );

      // Signalled, not merely outlived: each exits on its SIGTERM.
      expect(await exited(bridgeWorker)).toBe(true);
      expect(await exited(utilityWorker)).toBe(true);
      expect(events.join("\n")).toContain('"event":"workspace-released"');
      const after = readRunManifest(manifestPath);
      expect(after?.state).toBe("stopped");
      expect(after?.workspaceReleasedAt).toBeDefined();
      expect(
        readFileSync(join(runDir, "bridge-worker.json"), "utf8")
      ).toContain(String(bridgeWorker));
    } finally {
      for (const pid of children) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
      rmSync(root, { force: true, recursive: true });
      rmSync(tmuxTmp, { force: true, recursive: true });
    }
  },
  30_000
);

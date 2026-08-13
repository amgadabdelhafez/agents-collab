import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bridgeInternals } from "../../src/loop/bridge";
import {
  type BridgeMessage,
  markBridgeMessage,
  readBridgeEvents,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";
import { runGit } from "../../src/loop/git";
import {
  createRunManifest,
  readRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { Agent, Options, RunResult } from "../../src/loop/types";

type PairedLoopModule = typeof import("../../src/loop/paired-loop");
type RunnerModule = typeof import("../../src/loop/runner");

const projectRoot = process.cwd();
const claudeSdkPath = resolve(projectRoot, "src/loop/claude-sdk-server.ts");
const codexAppServerPath = resolve(projectRoot, "src/loop/codex-app-server.ts");
const runnerPath = resolve(projectRoot, "src/loop/runner.ts");

const makeTempHome = (): string =>
  mkdtempSync(join(tmpdir(), "loop-paired-int-"));
const makeOptions = (): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify with tests",
});
const makeResult = (parsed: string): RunResult => ({
  combined: "",
  exitCode: 0,
  parsed,
});

let importNonce = 0;
let realRunnerNonce = 0;
let currentRunDir = "";
let lastClaudeSessionId = "";
let lastCodexThreadId = "";
const calls: Array<{ agent: Agent; prompt: string }> = [];
const observedCodexThreadIdsAtTurnStart: string[] = [];
const startAppServerCalls: Array<{
  resumeThreadId?: string;
  threadModel?: string;
}> = [];
let realRunnerModulePromise: Promise<RunnerModule> | undefined;

const loadRealRunner = (): Promise<RunnerModule> => {
  if (!realRunnerModulePromise) {
    realRunnerNonce += 1;
    realRunnerModulePromise = import(
      `../../src/loop/runner.ts?paired-loop-integration-runner=${realRunnerNonce}`
    );
  }
  return realRunnerModulePromise;
};

const loadPairedLoop = (): Promise<PairedLoopModule> => {
  mock.module(claudeSdkPath, () => ({
    getLastClaudeSessionId: () => lastClaudeSessionId,
    hasClaudeSdkProcess: mock(() => false),
    interruptClaudeSdk: mock(() => undefined),
    runClaudeTurn: mock(
      (prompt: string, _opts: Options): Promise<RunResult> => {
        calls.push({ agent: "claude", prompt });
        if (prompt.includes("Review this completed work")) {
          return Promise.resolve(makeResult("<review>PASS</review>"));
        }
        return Promise.resolve(
          makeResult("Claude acknowledged the bridge message.\n<done/>")
        );
      }
    ),
    startClaudeSdk: mock((_model: string, sessionId?: string) => {
      lastClaudeSessionId = sessionId ?? "claude-session-1";
      return Promise.resolve();
    }),
  }));

  mock.module(codexAppServerPath, () => ({
    CODEX_TRANSPORT_ENV: "CODEX_TRANSPORT",
    CODEX_TRANSPORT_EXEC: "exec",
    CodexAppServerFallbackError: class extends Error {},
    CodexAppServerUnexpectedExitError: class extends Error {},
    getLastCodexThreadId: () => lastCodexThreadId,
    hasAppServerProcess: mock(() => false),
    interruptAppServer: mock(() => undefined),
    runCodexTurn: mock((prompt: string, _opts: Options): Promise<RunResult> => {
      const manifest = readRunManifest(join(currentRunDir, "manifest.json"));
      observedCodexThreadIdsAtTurnStart.push(manifest?.codexThreadId ?? "");
      calls.push({ agent: "codex", prompt });
      if (prompt.includes("Create a draft GitHub pull request")) {
        return Promise.resolve(makeResult(""));
      }
      bridgeInternals.appendBridgeEvent(currentRunDir, {
        at: "2026-03-22T10:00:00.000Z",
        id: "bridge-1",
        kind: "message",
        message: "Please review the implementation details.",
        source: "codex",
        target: "claude",
      });
      return Promise.resolve(
        makeResult("Codex finished the first turn.\n<done/>")
      );
    }),
    startAppServer: mock(
      (launchOptions?: { resumeThreadId?: string; threadModel?: string }) => {
        startAppServerCalls.push({
          resumeThreadId: launchOptions?.resumeThreadId,
          threadModel: launchOptions?.threadModel,
        });
        if (launchOptions?.threadModel) {
          lastCodexThreadId = "codex-thread-1";
        }
        return Promise.resolve();
      }
    ),
    useAppServer: () => true,
  }));

  mock.module(runnerPath, () => ({
    runAgent: (...args: Parameters<RunnerModule["runAgent"]>) =>
      loadRealRunner().then((module) => module.runAgent(...args)),
    runReviewerAgent: (...args: Parameters<RunnerModule["runReviewerAgent"]>) =>
      loadRealRunner().then((module) => module.runReviewerAgent(...args)),
    startPersistentAgentSession: (
      ...args: Parameters<RunnerModule["startPersistentAgentSession"]>
    ) =>
      loadRealRunner().then((module) =>
        module.startPersistentAgentSession(...args)
      ),
  }));

  importNonce += 1;
  return import(
    `../../src/loop/paired-loop.ts?paired-loop-integration=${importNonce}`
  );
};

afterEach(() => {
  mock.restore();
  calls.length = 0;
  realRunnerModulePromise = undefined;
  realRunnerNonce = 0;
  currentRunDir = "";
  lastClaudeSessionId = "";
  lastCodexThreadId = "";
  observedCodexThreadIdsAtTurnStart.length = 0;
  startAppServerCalls.length = 0;
});

test("runPairedLoop forwards a real bridge message in default paired mode", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "41";
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: projectRoot,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      sourceTaskSha256: "4".repeat(64),
      state: "submitted",
    })
  );

  try {
    await module.runPairedLoop("Ship feature", makeOptions());

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.agent)).toEqual([
      "codex",
      "claude",
      "claude",
      "codex",
    ]);
    expect(startAppServerCalls[0]?.threadModel).toBe("test-model");
    expect(observedCodexThreadIdsAtTurnStart[0]).toBe("codex-thread-1");
    expect(calls[1]?.prompt).toContain(
      "Message from Codex via the loop bridge:"
    );
    expect(calls[1]?.prompt).toContain(
      "Please review the implementation details."
    );
    expect(calls[2]?.prompt).toContain("Review this completed work");
    expect(calls[3]?.prompt).toContain("Create a draft GitHub pull request");
    const pending = readPendingBridgeMessages(storage.runDir);
    expect(
      pending.filter((message) => message.target !== "supervisor")
    ).toHaveLength(0);
    expect(
      pending.filter((message) => message.target === "supervisor")
    ).toHaveLength(1);
    expect(
      JSON.parse(
        pending.find((message) => message.target === "supervisor")?.message ??
          "null"
      )
    ).toMatchObject({ repositoryRoot: projectRoot });
    expect(readRunManifest(storage.manifestPath)?.status).toBe("done");
    expect(lastClaudeSessionId).toBe("claude-session-1");
    expect(lastCodexThreadId).toBe("codex-thread-1");
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("runPairedLoop durably closes a completed run to the supervisor with exact identity", async () => {
  const module = await loadPairedLoop();
  const preservedHome = process.env.LOOP_D5_REPRO_HOME;
  const home = preservedHome ? resolve(preservedHome) : makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "d5-supervisor-close";
  const sourceTaskSha256 = "5".repeat(64);
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: projectRoot,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      sourceTaskSha256,
      state: "submitted",
      workspaceBinding: {
        repoId: storage.repoId,
        root: projectRoot,
      },
    })
  );
  bridgeInternals.appendBridgeEvent(storage.runDir, {
    at: "2026-03-22T09:59:00.000Z",
    id: "unrelated-supervisor-status",
    kind: "message",
    message: "Progress update for the same run thread.",
    source: "codex",
    subject: "paired run progress",
    target: "supervisor",
    threadId: `${storage.repoId}:${runId}`,
  });

  try {
    await module.runPairedLoop("Ship feature", makeOptions());

    const manifest = readRunManifest(storage.manifestPath);
    expect(manifest?.status).toBe("done");
    const repositoryRoot = manifest?.workspaceBinding?.root ?? manifest?.cwd;
    expect(repositoryRoot).toBe(projectRoot);
    const git = runGit(repositoryRoot ?? "", ["rev-parse", "HEAD"]);
    expect(git.exitCode).toBe(0);
    const gitHead = git.stdout;
    const expectedPayload = {
      gitHead,
      kind: "paired-run-completed",
      repoId: storage.repoId,
      repositoryRoot: projectRoot,
      runId,
      sourceTaskSha256,
      status: "completed",
    };
    const supervisorCloses = readBridgeEvents(storage.runDir).filter(
      (event) => {
        if (
          event.kind !== "message" ||
          event.target !== "supervisor" ||
          event.type !== "ack" ||
          event.subject !== "paired run completed"
        ) {
          return false;
        }
        try {
          const payload = JSON.parse(event.message) as Record<string, unknown>;
          return (
            payload.kind === expectedPayload.kind &&
            payload.repoId === expectedPayload.repoId &&
            payload.repositoryRoot === expectedPayload.repositoryRoot &&
            payload.runId === expectedPayload.runId &&
            payload.sourceTaskSha256 === expectedPayload.sourceTaskSha256 &&
            payload.gitHead === expectedPayload.gitHead &&
            payload.status === expectedPayload.status
          );
        } catch {
          return false;
        }
      }
    );

    expect(supervisorCloses).toHaveLength(1);
    expect(JSON.parse(supervisorCloses[0]?.message ?? "null")).toEqual(
      expectedPayload
    );
    expect(supervisorCloses[0]).toMatchObject({
      dedupeKey: `paired-run-completed:${storage.repoId}:${runId}:${sourceTaskSha256}:${gitHead}`,
      taskId: sourceTaskSha256,
      threadId: `${storage.repoId}:${runId}`,
    });
    markBridgeMessage(
      storage.runDir,
      supervisorCloses[0] as BridgeMessage,
      "delivered",
      "supervisor accepted completion"
    );

    await module.runPairedLoop(
      "Ship feature",
      makeOptions({ resumeRunId: runId })
    );

    const replayedCloses = readBridgeEvents(storage.runDir).filter(
      (event) =>
        event.kind === "message" &&
        event.target === "supervisor" &&
        event.subject === "paired run completed"
    );
    expect(replayedCloses).toHaveLength(1);
    expect(readRunManifest(storage.manifestPath)?.status).toBe("done");
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    if (!preservedHome) {
      rmSync(home, { force: true, recursive: true });
    }
  }
});

test("runPairedLoop refuses healthy completion without source task identity", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "d5-missing-source";
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;

  try {
    await expect(
      module.runPairedLoop("Ship feature", makeOptions())
    ).rejects.toThrow("cannot complete without sourceTaskSha256");
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      state: "reviewing",
      status: "running",
    });
    expect(
      readBridgeEvents(storage.runDir).filter(
        (event) =>
          event.kind === "message" &&
          event.target === "supervisor" &&
          event.subject === "paired run completed"
      )
    ).toHaveLength(0);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("runPairedLoop prefers workspace binding root for completion Git identity", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "d5-workspace-root";
  const sourceTaskSha256 = "6".repeat(64);
  const workspaceRoot = "/bound/repository";
  const gitHead = "a".repeat(40);
  const gitRoots: string[] = [];
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: projectRoot,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      sourceTaskSha256,
      state: "submitted",
      workspaceBinding: { repoId: storage.repoId, root: workspaceRoot },
    })
  );
  module.pairedLoopInternals.setDeps({
    runGit: (cwd) => {
      gitRoots.push(cwd);
      return { exitCode: 0, stderr: "", stdout: gitHead };
    },
  });

  try {
    await module.runPairedLoop("Ship feature", makeOptions());

    expect(gitRoots).toEqual([workspaceRoot]);
    const close = readBridgeEvents(storage.runDir).find(
      (event) =>
        event.kind === "message" &&
        event.target === "supervisor" &&
        event.subject === "paired run completed"
    );
    expect(JSON.parse(close?.message ?? "null")).toMatchObject({
      gitHead,
      repositoryRoot: workspaceRoot,
    });
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("runPairedLoop keeps completion non-terminal when Git identity cannot resolve", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "d5-git-failure";
  const workspaceRoot = "/missing/repository";
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: projectRoot,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      sourceTaskSha256: "7".repeat(64),
      state: "submitted",
      workspaceBinding: { repoId: storage.repoId, root: workspaceRoot },
    })
  );
  module.pairedLoopInternals.setDeps({
    runGit: () => ({
      exitCode: 128,
      stderr: "not a git repository",
      stdout: "",
    }),
  });

  try {
    await expect(
      module.runPairedLoop("Ship feature", makeOptions())
    ).rejects.toThrow(`cannot resolve Git HEAD from ${workspaceRoot}`);
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      state: "reviewing",
      status: "running",
    });
    expect(
      readBridgeEvents(storage.runDir).filter(
        (event) =>
          event.kind === "message" &&
          event.target === "supervisor" &&
          event.subject === "paired run completed"
      )
    ).toHaveLength(0);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("runPairedLoop keeps completion non-terminal when supervisor enqueue is full", async () => {
  const module = await loadPairedLoop();
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const runId = "d5-enqueue-full";
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, projectRoot, home);
  currentRunDir = storage.runDir;
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: projectRoot,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      sourceTaskSha256: "8".repeat(64),
      state: "submitted",
    })
  );
  for (let index = 0; index < 33; index += 1) {
    bridgeInternals.appendBridgeEvent(storage.runDir, {
      at: `2026-03-22T10:00:${String(index).padStart(2, "0")}.000Z`,
      id: `supervisor-backlog-${index}`,
      kind: "message",
      message: `pending supervisor message ${index}`,
      source: "codex",
      target: "supervisor",
    });
  }

  try {
    await expect(
      module.runPairedLoop("Ship feature", makeOptions())
    ).rejects.toThrow("could not durably enqueue supervisor completion");
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      state: "reviewing",
      status: "running",
    });
    expect(
      readBridgeEvents(storage.runDir).filter(
        (event) =>
          event.kind === "message" &&
          event.target === "supervisor" &&
          event.subject === "paired run completed"
      )
    ).toHaveLength(0);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

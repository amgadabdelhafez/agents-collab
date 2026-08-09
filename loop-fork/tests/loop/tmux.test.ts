import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runGit } from "../../src/loop/git";
import {
  GOVERNESS_DEAD_PANE_BORDER_FORMAT,
  GOVERNESS_PANE_DIED_SUBCOMMAND,
  GOVERNESS_REMAIN_ON_EXIT_FORMAT,
} from "../../src/loop/governess-pane-liveness";
import {
  createRunManifest,
  type RunManifest,
  resolveRunStorage,
  setRunManifestState,
  writeRunManifest,
} from "../../src/loop/run-state";
import {
  runInTmux,
  TMUX_MISSING_ERROR,
  tmuxInternals,
} from "../../src/loop/tmux";
import type { Options } from "../../src/loop/types";

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-tmux-"));
const makeTempRunDir = (): string =>
  mkdtempSync(join(tmpdir(), "loop-tmux-run-"));

const tmuxCommand = (args: readonly string[]): string | undefined =>
  args[0] === "tmux" && args[1] === "-S" ? args[3] : args[1];

const withoutTmuxSocket = (args: readonly string[]): readonly string[] =>
  args[0] === "tmux" && args[1] === "-S" ? [args[0], ...args.slice(3)] : args;

const KICKOFF_HOOKS_BEFORE =
  '{"agent":"claude","event":"SessionStart","state":"starting","sequence":1}\n';
const KICKOFF_HOOKS_AFTER = `${KICKOFF_HOOKS_BEFORE}{"agent":"claude","event":"UserPromptSubmit","state":"working","sequence":2}\n`;

// Every paired-launch fake must declare whether its Claude actually started a
// turn, because the launcher now refuses to report a run as started without
// that evidence. This is the healthy case: the first read is the pre-paste
// baseline, and every later read shows the UserPromptSubmit the kickoff caused.
const healthyClaudeKickoffDeps = (): {
  claudeCliVersion: () => string;
  readClaudeTranscriptVersion: () => string;
  readTextFile: () => string;
} => {
  let reads = 0;
  return {
    claudeCliVersion: () => "2.1.223 (Claude Code)",
    readClaudeTranscriptVersion: () => "",
    readTextFile: () => {
      reads += 1;
      return reads === 1 ? KICKOFF_HOOKS_BEFORE : KICKOFF_HOOKS_AFTER;
    },
  };
};
const claudeWarningFixtureDir = join(
  import.meta.dir,
  "..",
  "fixtures",
  "claude-code",
  "2.1.220",
  "dev-channel-preconnect-warning"
);
const readClaudeWarningFrame = (name: string): string =>
  readFileSync(join(claudeWarningFixtureDir, name), "utf8");
interface ClaudeWarningFixtureFrame {
  activeClients: number;
  cursor: { x: number; y: number };
  normalizedFile: string;
  panePipe: number;
  state: string;
  windowActivity: number;
}
interface ClaudeWarningFixtureIndex {
  activityProbe: { unsentDraft: string };
  frames: ClaudeWarningFixtureFrame[];
}
const claudeWarningFixtureIndex = JSON.parse(
  readClaudeWarningFrame("fixture-index.json")
) as ClaudeWarningFixtureIndex;
const claudeWarningFixtureState = (
  state: string
): ClaudeWarningFixtureFrame => {
  const frame = claudeWarningFixtureIndex.frames.find(
    (candidate) => candidate.state === state
  );
  if (!frame) {
    throw new Error(`missing Claude warning fixture state: ${state}`);
  }
  return frame;
};
const readClaudeWarningState = (state: string): string =>
  readClaudeWarningFrame(claudeWarningFixtureState(state).normalizedFile);
const readClaudeWarningComposer = (text: string): string => {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith("❯"));
  const composer = line?.trimStart().slice("❯".length).trim();
  if (!composer) {
    throw new Error("captured Claude fixture has no populated composer");
  }
  return composer;
};

const currentRunBase = (
  cwd: string = process.cwd(),
  requestedId?: string
): string => {
  const gitResult = (args: string[]) => {
    try {
      return runGit(cwd, args, "ignore");
    } catch {
      return undefined;
    }
  };
  const commonDir = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDir?.exitCode === 0 && commonDir.stdout) {
    return tmuxInternals.sanitizeBase(basename(dirname(commonDir.stdout)));
  }

  const topLevel = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (topLevel?.exitCode === 0 && topLevel.stdout) {
    return tmuxInternals.sanitizeBase(basename(topLevel.stdout));
  }

  const base = tmuxInternals.sanitizeBase(basename(cwd));
  if (requestedId) {
    const suffix = `-loop-${tmuxInternals.sanitizeBase(requestedId)}`;
    if (base.endsWith(suffix)) {
      return base.slice(0, -suffix.length) || "loop";
    }
  }
  return base.replace(/-loop-[a-z0-9][a-z0-9_-]*$/i, "") || "loop";
};

const makePairedOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  ossConfigDir: "/tmp/loop-oss-config",
  ossModel: "openrouter/z-ai/glm-5.2",
  pairedMode: true,
  proof: "verify with tests",
  review: "claudex",
  ...overrides,
});

const withTempHomeRunManifest = async (
  runId: string,
  fn: (home: string) => void | Promise<void>,
  manifestOverrides: Partial<Parameters<typeof createRunManifest>[0]> = {}
): Promise<void> => {
  const home = makeTempHome();
  try {
    const storage = resolveRunStorage(runId, process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId,
          status: "running",
          ...manifestOverrides,
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    await fn(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
};

test("paired command builders default both providers to medium effort", () => {
  const claude = tmuxInternals.buildClaudeCommand(
    "claude-session",
    "opus",
    "loop-bridge-repo-1",
    false
  );
  const claudeEffortIndex = claude.indexOf("--effort");
  expect(claude.slice(claudeEffortIndex, claudeEffortIndex + 2)).toEqual([
    "--effort",
    "medium",
  ]);

  const codex = tmuxInternals.buildCodexCommand(
    "ws://127.0.0.1:4600/",
    "gpt-test",
    []
  );
  const effortValues = codex.filter((value) =>
    value.startsWith("model_reasoning_effort=")
  );
  expect(effortValues).toEqual(['model_reasoning_effort="medium"']);
});

test("paired command builder maps asymmetric role effort to either provider", () => {
  const common = {
    claudeChannelServer: "loop-bridge-repo-1",
    claudeSessionId: "claude-session",
    codexProxyUrl: "ws://127.0.0.1:4600/",
    hadSession: false,
    nativeSubagentMode: "off" as const,
  };
  const roles = [
    { agent: "claude" as const, pairWith: "codex" as const },
    { agent: "codex" as const, pairWith: "claude" as const },
  ];

  for (const role of roles) {
    const opts = makePairedOptions({
      agent: role.agent,
      codexMcpConfigArgs: [
        "-c",
        'mcp_servers.loop-bridge.command="loop"',
        "-c",
        'model_reasoning_effort="max"',
      ],
      driverEffort: "medium",
      pairWith: role.pairWith,
      reviewerEffort: "high",
    });
    const claude = tmuxInternals.buildPairedAgentCommand({
      ...common,
      agent: "claude",
      opts,
    });
    const codex = tmuxInternals.buildPairedAgentCommand({
      ...common,
      agent: "codex",
      opts,
    });
    const claudeEffortIndex = claude.indexOf("--effort");
    const codexEffort = codex.filter((value) =>
      value.startsWith("model_reasoning_effort=")
    );
    const claudeExpected = role.agent === "claude" ? "medium" : "high";
    const codexExpected = role.agent === "codex" ? "medium" : "high";

    expect(claude.slice(claudeEffortIndex, claudeEffortIndex + 2)).toEqual([
      "--effort",
      claudeExpected,
    ]);
    expect(codexEffort).toEqual([
      `model_reasoning_effort=${JSON.stringify(codexExpected)}`,
    ]);
  }
});

test("runInTmux returns false when --tmux is not present", async () => {
  const delegated = await runInTmux(["--proof", "verify"], {
    findBinary: () => true,
  });

  expect(delegated).toBe(false);
});

test("runInTmux starts a detached session without auto-attach when already inside tmux", async () => {
  const calls: string[][] = [];
  const attaches: string[] = [];

  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    attach: (session: string) => {
      attaches.push(session);
    },
    cwd: "/repo",
    env: { TMUX: "1" },
    findBinary: () => true,
    getTerminalSize: () => undefined,
    isInteractive: () => true,
    launchArgv: ["bun", "/repo/src/cli.ts"],
    log: (): void => undefined,
    resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
    spawn: (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    },
  });

  expect(delegated).toBe(true);
  expect(calls).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "new-session",
      "-s",
      "repo-loop-1",
      "-d",
      "-c",
      "/repo",
      "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=1' 'bun' '/repo/src/cli.ts' '--proof' 'verify'",
    ],
    ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", "repo-loop-1"],
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "set-window-option",
      "-t",
      "repo-loop-1:0",
      "remain-on-exit",
      "on",
    ],
  ]);
  expect(attaches).toEqual([]);
});

test("runInTmux throws install message when tmux is missing", async () => {
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      cwd: "/repo",
      env: {},
      findBinary: () => false,
    })
  ).rejects.toThrow(TMUX_MISSING_ERROR);
});

test("runInTmux exposes launch socket failure before tmux contact", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];

  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      log: (line: string) => {
        logs.push(line);
      },
      resolveLaunchSocket: () => {
        throw new Error("launch socket is unknown");
      },
      spawn: (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
    })
  ).rejects.toThrow("launch socket is unknown");

  expect(calls).toEqual([]);
  expect(logs.some((line) => line.includes("attach with:"))).toBe(false);
  expect(logs.some((line) => line.includes("recorded before"))).toBe(false);
});

test("paired launch rejects a malformed recorded socket before tmux or persistent resources", async () => {
  const tmuxCalls: string[][] = [];
  let persistentStarts = 0;
  let proxyStarts = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
    tmuxSocket: "relative.sock",
  });
  const storage = {
    manifestPath: "/isolated/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/runs/repo-123",
    transcriptPath: "/isolated/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args) => {
          tmuxCalls.push(args);
          return { exitCode: 0, stderr: "" };
        },
        startCodexProxy: () => {
          proxyStarts += 1;
          return Promise.resolve("ws://127.0.0.1:4600/");
        },
        startPersistentAgentSession: () => {
          persistentStarts += 1;
          return Promise.resolve(undefined);
        },
      },
      { opts: makePairedOptions(), task: "Ship feature" }
    )
  ).rejects.toThrow("tmux socket unknown: socket is relative");

  expect(tmuxCalls).toEqual([]);
  expect(persistentStarts).toBe(0);
  expect(proxyStarts).toBe(0);
});

test("paired launch rejects undurable socket persistence before tmux or persistent resources", async () => {
  const tmuxCalls: string[][] = [];
  let persistentStarts = 0;
  let proxyStarts = 0;
  let manifestUpdates = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
  });
  const storage = {
    manifestPath: "/isolated/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/runs/repo-123",
    transcriptPath: "/isolated/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        preparePairedRun: () => ({ manifest, storage }),
        resolveLaunchSocket: () => "/tmp/paired.sock" as never,
        spawn: (args) => {
          tmuxCalls.push(args);
          return { exitCode: 0, stderr: "" };
        },
        startCodexProxy: () => {
          proxyStarts += 1;
          return Promise.resolve("ws://127.0.0.1:4600/");
        },
        startPersistentAgentSession: () => {
          persistentStarts += 1;
          return Promise.resolve(undefined);
        },
        updateRunManifest: () => {
          manifestUpdates += 1;
          return manifest;
        },
      },
      { opts: makePairedOptions(), task: "Ship feature" }
    )
  ).rejects.toThrow("Failed to persist tmux socket before paired launch");

  expect(manifestUpdates).toBe(1);
  expect(tmuxCalls).toEqual([]);
  expect(persistentStarts).toBe(0);
  expect(proxyStarts).toBe(0);
});

test("runInTmux socket-qualifies non-paired handoff probe, remain-on-exit, gone re-probe, and interactive attach", async () => {
  const calls: string[][] = [];
  const attaches: string[] = [];
  const logs: string[] = [];
  let resolverCalls = 0;
  const command =
    "'env' 'CLAUDE_CONFIG_DIR=/tmp/loop-claude' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=1' 'bun' '/repo/src/cli.ts' '--proof' 'verify' 'fix bug'";

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify", "fix bug"],
    {
      attach: (session: string) => {
        attaches.push(session);
      },
      cwd: "/repo",
      env: {
        CLAUDE_CONFIG_DIR: "/tmp/loop-claude",
        LOOP_TMUX_SOCKET: "/tmp/ls-b/decoy.sock",
        TMUX: "/tmp/ls-b/decoy.sock,900,0",
        TMUX_TMPDIR: "/tmp/ls-b",
      },
      findBinary: () => true,
      getTerminalSize: () => undefined,
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (line: string) => {
        logs.push(line);
      },
      resolveLaunchSocket: () => {
        resolverCalls += 1;
        return "/tmp/ls-a/a.sock" as never;
      },
      spawn: (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(resolverCalls).toBe(1);
  expect(calls[0]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "new-session",
    "-s",
    "repo-loop-1",
    "-d",
    "-c",
    "/repo",
    command,
  ]);
  expect(calls[1]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "has-session",
    "-t",
    "repo-loop-1",
  ]);
  expect(calls[2]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "set-window-option",
    "-t",
    "repo-loop-1:0",
    "remain-on-exit",
    "on",
  ]);
  expect(logs[0]).toBe("[loop] starting tmux session...");
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain(
    "[loop] attach with: tmux -S '/tmp/ls-a/a.sock' attach -t 'repo-loop-1'"
  );
  expect(JSON.stringify([calls[0], logs])).not.toContain("/tmp/ls-b");
  expect(attaches).toEqual([]);
});

test("runInTmux keeps explicit run id in single-agent mode", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;

  const delegated = await runInTmux(
    ["--tmux", "--codex-only", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args.includes("has-session")) {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && args.includes("new-session")) {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "has-session",
    "-t",
    "repo-loop-alpha",
  ]);
  expect(calls[1]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "new-session",
    "-s",
    "repo-loop-alpha",
    "-d",
    "-c",
    "/repo",
    "'env' 'LOOP_RUN_BASE=repo' 'LOOP_RUN_ID=alpha' 'bun' '/repo/src/cli.ts' '--codex-only' '--run-id' 'alpha' '--proof' 'verify'",
  ]);
  expect(calls[2]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "has-session",
    "-t",
    "repo-loop-alpha",
  ]);
  expect(calls[3]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "set-window-option",
    "-t",
    "repo-loop-alpha:0",
    "remain-on-exit",
    "on",
  ]);
});

test("runInTmux paired launch emits the exact run manifest path contract line", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const proxyCalls: Array<{
    remoteUrl: string;
    runDir: string;
    threadId: string;
  }> = [];
  const typed: Array<{ pane: string; text: string }> = [];
  const startCalls: Array<{
    agent: string;
    codexHome?: string;
    configValues?: string[];
    kind?: string;
    sessionId?: string;
  }> = [];
  const bootstrapManifests: RunManifest[] = [];
  const dependencySockets: Array<string | undefined> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxPaneGoverness: "%old-governess",
    tmuxPaneLeft: "%old-left",
    tmuxPaneRight: "%old-right",
    // Bound by the launch reservation before this launch began (T-04 phase 1).
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const opts = makePairedOptions({
    agent: "claude",
    driverEffort: "medium",
    driverEffortSource: "cli-role",
    pairWith: "codex",
    reviewerEffort: "high",
    reviewerEffortSource: "cli-role",
  });
  const codexMcpConfigArgs = ["-c", 'mcp_servers.loop-bridge.command="loop"'];
  const codexHome = "/repo/.loop/runs/1/codex-home";
  const codexRemoteUrl = "ws://127.0.0.1:4500";
  const codexProxyUrl = "ws://127.0.0.1:4600/";
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: (_pane, _styled, socket) => {
        dependencySockets.push(socket);
        return "❯ ";
      },
      capturePaneSnapshot: (_pane, socket) => {
        dependencySockets.push(socket);
        return undefined;
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => codexRemoteUrl,
      getLastCodexThreadId: () => "codex-thread-1",
      getTerminalSize: () => ({ columns: 160, rows: 48 }),
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (line: string) => {
        logs.push(line);
      },
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = codexMcpConfigArgs;
        nextOpts.codexHome = codexHome;
        manifest = {
          ...manifest,
          driverEffort: nextOpts.driverEffort,
          reviewerEffort: nextOpts.reviewerEffort,
        };
        return { manifest, storage };
      },
      sendKeys: (_pane, _keys, socket): void => {
        dependencySockets.push(socket);
      },
      sendText: (pane: string, text: string, socket) => {
        dependencySockets.push(socket);
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: (
        runDir: string,
        remoteUrl: string,
        threadId: string
      ) => {
        proxyCalls.push({ remoteUrl, runDir, threadId });
        return Promise.resolve(codexProxyUrl);
      },
      startPersistentAgentSession: (agent, _opts, sessionId, launch, kind) => {
        bootstrapManifests.push(structuredClone(manifest));
        startCalls.push({
          agent,
          codexHome: launch?.codexLaunch?.env?.CODEX_HOME,
          configValues: launch?.codexLaunch?.configValues,
          kind,
          nativeSubagentMode:
            launch?.codexLaunch?.env?.LOOP_NATIVE_SUBAGENT_MODE,
          sessionId,
        });
        return Promise.resolve(undefined);
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : {
                exitCode: 1,
                stderr:
                  "error connecting to /private/tmp/tmux-501/cold-smoke (No such file or directory)",
              };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  const env = [
    "LOOP_RUN_BASE=repo",
    "LOOP_RUN_ID=1",
    `CODEX_HOME=${codexHome}`,
  ];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    storage.repoId
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      false,
      undefined,
      undefined,
      join(storage.runDir, "claude-mcp.json"),
      "off",
      "medium"
    ),
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand(
      codexProxyUrl,
      "test-model",
      codexMcpConfigArgs,
      undefined,
      undefined,
      "off",
      "high"
    ),
  ]);

  expect(delegated).toBe(true);
  expect(logs).toContain(
    '[loop] run manifest "/repo/.loop/runs/1/manifest.json"'
  );
  expect(proxyCalls).toEqual([
    {
      remoteUrl: codexRemoteUrl,
      runDir: storage.runDir,
      threadId: "codex-thread-1",
    },
  ]);
  expect(startCalls).toEqual([
    {
      agent: "codex",
      codexHome,
      configValues: [...codexMcpConfigArgs, 'model_reasoning_effort="high"'],
      kind: "review",
      nativeSubagentMode: "off",
      sessionId: undefined,
    },
  ]);
  expect(bootstrapManifests).toHaveLength(1);
  expect(bootstrapManifests[0]).toMatchObject({
    cwd: "/repo",
    mode: "paired",
    pid: process.pid,
    primaryAgent: "claude",
    driverEffort: "medium",
    reviewerEffort: "high",
    tmuxPaneLeftAgent: "claude",
    tmuxPaneRightAgent: "codex",
    // verify 4: the manifest observed at the FIRST persistent-agent start must
    // already carry BOTH identities. A session without its socket is the
    // split-brain state this change exists to close.
    tmuxSession: "repo-loop-1",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  expect(bootstrapManifests[0]?.tmuxPaneGoverness).toBeUndefined();
  expect(bootstrapManifests[0]?.tmuxPaneLeft).toBeUndefined();
  expect(bootstrapManifests[0]?.tmuxPaneRight).toBeUndefined();
  const pairedTmuxCalls = calls.filter((call) => call[0] === "tmux");
  expect(pairedTmuxCalls.length).toBeGreaterThan(0);
  expect(
    pairedTmuxCalls.every(
      (call) => call[1] === "-S" && call[2] === "/tmp/ls-a/a.sock"
    )
  ).toBe(true);
  expect(dependencySockets.length).toBeGreaterThan(0);
  expect(
    dependencySockets.every((socket) => socket === "/tmp/ls-a/a.sock")
  ).toBe(true);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-x",
    "160",
    "-y",
    "48",
    "-s",
    "repo-loop-1",
    "-c",
    "/repo",
    claudeCommand,
  ]);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    "repo-loop-1:0.0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(
    calls.filter((call) => tmuxCommand(call) === "load-buffer")
  ).toHaveLength(2);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "paste-buffer",
    "-d",
    "-p",
    "-b",
    "repo-loop-1-claude-launch",
    "-t",
    "repo-loop-1:0.0",
  ]);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "paste-buffer",
    "-d",
    "-p",
    "-b",
    "repo-loop-1-codex-launch",
    "-t",
    "repo-loop-1:0.1",
  ]);
  expect(typed).toEqual([]);
  expect(logs[0]).toBe("[loop] starting paired tmux workspace...");
  expect(logs).toContain('[loop] started tmux session "repo-loop-1"');
  expect(logs).toContain(
    "[loop] attach with: tmux -S '/tmp/ls-a/a.sock' attach -t 'repo-loop-1'"
  );
  expect(manifest.claudeSessionId).toBe("claude-session-1");
  expect(manifest.codexRemoteUrl).toBe(codexRemoteUrl);
  expect(manifest.codexThreadId).toBe("codex-thread-1");
  expect(manifest.tmuxSession).toBe("repo-loop-1");
  expect(manifest.tmuxPaneLeftAgent).toBe("claude");
  expect(manifest.tmuxPaneRightAgent).toBe("codex");
});

test.each([
  [
    "cold macOS socket during initial preflight",
    "error connecting to /private/tmp/tmux-501/cold-smoke (No such file or directory)",
    true,
    true,
  ],
  [
    "missing macOS socket after resource creation",
    "error connecting to /private/tmp/tmux-501/cold-smoke (No such file or directory)",
    false,
    false,
  ],
  ["missing named session", "can't find session: cold-smoke", false, true],
  ["permission failure", "permission denied", true, false],
  [
    "overlong socket path",
    "error connecting to /private/tmp/tmux-501/cold-smoke (File name too long)",
    true,
    false,
  ],
] as const)("tmux absence classification handles %s without widening cleanup authority", (_label, detail, allowMissingSocket, expected) => {
  expect(
    tmuxInternals.isConfirmedMissingTmuxSession(detail, allowMissingSocket)
  ).toBe(expected);
});

test("runInTmux preserves stable pane targets when reattaching a live paired session", async () => {
  const calls: string[][] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxPaneGoverness: "%governess",
    tmuxPaneLeft: "%left",
    tmuxPaneLeftAgent: "claude",
    tmuxPaneRight: "%right",
    tmuxPaneRightAgent: "codex",
    tmuxSession: "repo-loop-1",
    tmuxSocket: "/tmp/recorded.sock",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/1",
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      log: (): void => undefined,
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: () => ({ manifest, storage }),
      resolveLaunchSocket: () => {
        throw new Error("recorded socket must bypass ambient resolution");
      },
      spawn: (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual([
    "tmux",
    "-S",
    "/tmp/recorded.sock",
    "has-session",
    "-t",
    "repo-loop-1",
  ]);
  expect(
    calls
      .filter((args) => args[0] === "tmux")
      .every((args) => args[1] === "-S" && args[2] === "/tmp/recorded.sock")
  ).toBe(true);
  expect(calls.some((args) => tmuxCommand(args) === "new-session")).toBe(false);
  expect(manifest).toMatchObject({
    tmuxPaneGoverness: "%governess",
    tmuxPaneLeft: "%left",
    tmuxPaneRight: "%right",
    tmuxSession: "repo-loop-1",
  });
});

test("runInTmux transports a realistic charter through hash-bound pointer bootstraps", async () => {
  const calls: string[][] = [];
  const submissionEvents: string[] = [];
  const loadedPrompts: Array<{
    buffer: string;
    content: string;
    path: string;
  }> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const task = `BEGIN-LARGE-CHARTER\n${"x".repeat(10_257)}`;
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => "❯ ",
      closePersistentCodexSession: () => Promise.resolve(),
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerPid: () => undefined,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      releasePersistentCodexSession: (): void => undefined,
      sendKeys: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "load-buffer") {
          const tmuxArgs = withoutTmuxSocket(args);
          const path = tmuxArgs[4] ?? "";
          loadedPrompts.push({
            buffer: tmuxArgs[3] ?? "",
            content: readFileSync(path, "utf8"),
            path,
          });
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "paste-buffer") {
          const pane = args.at(-1) ?? "";
          submissionEvents.push(`paste:${pane}`);
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "send-keys") {
          submissionEvents.push(`enter:${withoutTmuxSocket(args)[3] ?? ""}`);
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task }
  );

  expect(delegated).toBe(true);
  expect(loadedPrompts).toHaveLength(2);
  for (const prompt of loadedPrompts) {
    expect(prompt.content).not.toContain(task);
    expect(Buffer.byteLength(prompt.content, "utf8")).toBeLessThan(1024);
    expect(prompt.content).toContain("Expected SHA-256:");
    expect(prompt.content).toContain("fail closed");
    expect(prompt.path.startsWith(storage.runDir)).toBe(true);
    expect(existsSync(prompt.path)).toBe(true);
    expect(statSync(prompt.path).mode % 0o1000).toBe(0o600);
  }
  expect(statSync(dirname(loadedPrompts[0]?.path ?? "")).mode % 0o1000).toBe(
    0o700
  );
  expect(Object.keys(manifest.launchCharters ?? {}).sort()).toEqual([
    "claude",
    "codex",
  ]);
  for (const binding of Object.values(manifest.launchCharters ?? {})) {
    expect(binding).toBeDefined();
    const content = readFileSync(binding?.path ?? "", "utf8");
    expect(statSync(binding?.path ?? "").mode % 0o1000).toBe(0o600);
    expect(content).toContain(task);
    expect(binding?.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(binding?.sha256).toBe(
      createHash("sha256").update(content, "utf8").digest("hex")
    );
  }
  const workspaceCommands = calls.filter(
    (call) =>
      tmuxCommand(call) === "new-session" ||
      tmuxCommand(call) === "split-window"
  );
  expect(workspaceCommands).toHaveLength(2);
  for (const call of workspaceCommands) {
    const command = call.at(-1) ?? "";
    expect(command).not.toContain("BEGIN-LARGE-CHARTER");
    expect(command.length).toBeLessThan(4096);
  }
  expect(
    calls.filter((call) => tmuxCommand(call) === "send-keys")
  ).toHaveLength(2);
  for (const pane of ["repo-loop-1:0.0", "repo-loop-1:0.1"]) {
    expect(submissionEvents.indexOf(`paste:${pane}`)).toBeLessThan(
      submissionEvents.indexOf(`enter:${pane}`)
    );
  }
});

test("runInTmux writes paired session refs before starting governess", async () => {
  const calls: string[][] = [];
  const events: string[] = [];
  const home = makeTempHome();
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions({
    governess: true,
    governessCooldownSeconds: 300,
    governessHeight: "25%",
    governessIdleSeconds: 120,
    governessLlmTrace: "1",
    governessMaxRecoveries: 3,
    governessModel: "qwen-test",
    governessUrl: "http://127.0.0.1:8082",
  });
  const runDir = join(home, "run");
  const repoDir = join(home, "repo");
  const storage = {
    manifestPath: join(runDir, "manifest.json"),
    repoId: "repo-123",
    runDir,
    runId: "1",
    storageRoot: join(home, "runs"),
    transcriptPath: join(runDir, "transcript.jsonl"),
  };

  try {
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, ".env"),
      [
        "export USAGE_TRACKER_SECRET=dotenv-secret",
        "USAGE_TRACKER_URL=http://tracker.local",
      ].join("\n")
    );
    const delegated = await runInTmux(
      ["--tmux", "--proof", "verify with tests", "--governess"],
      {
        capturePane: () => "❯ ",
        cwd: repoDir,
        env: {
          CLAUDE_CONFIG_DIR: "/tmp/loop-claude",
          LOOP_GOVERNESS_AGENT_RENAME: "1",
        },
        findBinary: () => true,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          nextOpts.codexHome = join(runDir, "codex-home");
          return { manifest, storage };
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: (_agent, _opts, _sessionId, launch) => {
          const hooksPath = join(runDir, "codex-home", "hooks.json");
          events.push(
            `start-codex:${existsSync(hooksPath)}:${launch?.codexLaunch?.env?.LOOP_NATIVE_SUBAGENT_MODE ?? ""}`
          );
          if (existsSync(hooksPath)) {
            events.push(
              `codex-hook-event:${readFileSync(hooksPath, "utf8").includes("PreToolUse")}`
            );
          }
          const fallbackPath = join(
            runDir,
            "codex-home",
            "agents",
            "loop_readonly_fallback.toml"
          );
          events.push(`codex-child-profile:${existsSync(fallbackPath)}`);
          return Promise.resolve(undefined);
        },
        spawn: (args: string[]) => {
          calls.push(args);
          if (args.some((arg) => arg.includes("__governess"))) {
            events.push(
              `spawn-governess:${manifest.codexThreadId}:${manifest.tmuxPaneRight ?? ""}:${manifest.tmuxPaneGoverness ?? ""}`
            );
            events.push(`governess-command:${args.at(-1) ?? ""}`);
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
            return { exitCode: 0, stderr: "", stdout: "%40\n" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "split-window") {
            if (
              args.some(
                (arg) => arg.includes("__recon-pane") && arg.includes("'1'")
              )
            ) {
              return { exitCode: 0, stderr: "", stdout: "%45\n" };
            }
            if (
              args.some(
                (arg) => arg.includes("__recon-pane") && arg.includes("'2'")
              )
            ) {
              return { exitCode: 0, stderr: "", stdout: "%46\n" };
            }
            if (
              args.some(
                (arg) => arg.includes("__recon-pane") && arg.includes("'3'")
              )
            ) {
              return { exitCode: 0, stderr: "", stdout: "%47\n" };
            }
            if (args.some((arg) => arg.includes("__au-pair-pane"))) {
              return { exitCode: 0, stderr: "", stdout: "%42\n" };
            }
            if (args.some((arg) => arg.includes("__nanny-pane"))) {
              return { exitCode: 0, stderr: "", stdout: "%44\n" };
            }
            if (args.includes("-h")) {
              return { exitCode: 0, stderr: "", stdout: "%41\n" };
            }
            if (args.includes("-f")) {
              return { exitCode: 0, stderr: "", stdout: "%43\n" };
            }
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          events.push(
            `manifest:${manifest.codexThreadId}:${manifest.tmuxPaneRight ?? ""}:${manifest.tmuxPaneGoverness ?? ""}`
          );
          return manifest;
        },
      },
      { opts, task: "Ship feature" }
    );

    expect(delegated).toBe(true);
    expect(events).toContain("start-codex:true:utility-first");
    expect(events).toContain("codex-hook-event:true");
    expect(events).toContain("codex-child-profile:false");
    expect(events).toContain("manifest:codex-thread-1:%41:repo-loop-1:0.2");
    expect(events).toContain(
      "spawn-governess:codex-thread-1:%41:repo-loop-1:0.2"
    );
    expect(events).toContain("spawn-governess:codex-thread-1:%41:%43");
    expect(events).toContain("manifest:codex-thread-1:%41:%43");
    expect(events.indexOf("manifest:codex-thread-1:%41:%43")).toBeLessThan(
      events.lastIndexOf("spawn-governess:codex-thread-1:%41:%43")
    );
    expect(
      events.some((event) => event.includes("'LOOP_GOVERNESS_LLM_TRACE=1'"))
    ).toBe(true);
    expect(
      events.some((event) => event.includes("'LOOP_GOVERNESS_AGENT_RENAME=1'"))
    ).toBe(true);
    expect(
      calls
        .filter(
          (args) =>
            args[0] === "tmux" &&
            (tmuxCommand(args) === "new-session" ||
              tmuxCommand(args) === "split-window")
        )
        .every((args) =>
          args.at(-1)?.includes("'CLAUDE_CONFIG_DIR=/tmp/loop-claude'")
        )
    ).toBe(true);
    // Binds the COMPOSED pane command to buildPairedPaneEnv — presence AND
    // ordering. An earlier version filtered on the marker and `continue`d,
    // which made it vacuous: omitting the unsets entirely (or from one pane)
    // left nothing to assert and the suite stayed green. Asserting the expected
    // COUNT first is what makes omission a failure rather than a skip.
    // Mis-ordering is the loud failure (`env: -u: No such file...`, exit 127);
    // omission is the silent one that quietly restores the fleet bypass.
    const governedCommands = calls
      .filter(
        (call) =>
          call[0] === "tmux" &&
          (tmuxCommand(call) === "new-session" ||
            tmuxCommand(call) === "split-window")
      )
      .map((call) => call.at(-1) ?? "")
      .filter((command) =>
        command.includes("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")
      );
    // Exactly the two agent panes: the left `new-session` and the right
    // `split-window`. Governess, Au Pair, Nanny and the recon panes are not
    // agent panes and legitimately carry no unsets.
    expect(governedCommands).toHaveLength(2);
    for (const command of governedCommands) {
      expect(command).toContain("'-u' 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'");
      expect(command).toContain(
        "'-u' 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS'"
      );
      const unsetAt = command.indexOf("'-u'");
      const firstAssignmentAt = command.search(/'[A-Z_]+=/);
      expect(unsetAt).toBeGreaterThanOrEqual(0);
      expect(unsetAt).toBeLessThan(firstAssignmentAt);
    }
    expect(
      events.some((event) =>
        event.includes("'USAGE_TRACKER_URL=http://tracker.local'")
      )
    ).toBe(true);
    expect(
      events.some((event) =>
        event.includes("'USAGE_TRACKER_SECRET=dotenv-secret'")
      )
    ).toBe(true);
    expect(
      events.indexOf("manifest:codex-thread-1:%41:repo-loop-1:0.2")
    ).toBeLessThan(
      events.indexOf("spawn-governess:codex-thread-1:%41:repo-loop-1:0.2")
    );
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-l",
      "20%",
      "-t",
      "%43",
      "-c",
      repoDir,
      expect.stringContaining("__au-pair-pane"),
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%42",
      "@loop_label",
      "au-pair.repo-loop-1",
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "select-pane",
      "-t",
      "%42",
      "-T",
      "au-pair.repo-loop-1",
    ]);
    expect(manifest.tmuxPaneLeft).toBe("%40");
    expect(manifest.tmuxPaneUtility).toBe("%42");
    expect(manifest.tmuxPaneAuPair).toBe("%42");
    expect(manifest.tmuxPaneNanny).toBe("%44");
    expect(manifest.tmuxPaneRight).toBe("%41");
    expect(manifest.tmuxPaneGoverness).toBe("%43");
    expect(manifest.tmuxPaneRecon).toEqual(["%45"]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%43",
      "remain-on-exit",
      "on",
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%43",
      "remain-on-exit-format",
      GOVERNESS_REMAIN_ON_EXIT_FORMAT,
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-option",
      "-t",
      "repo-loop-1",
      "pane-border-format",
      GOVERNESS_DEAD_PANE_BORDER_FORMAT,
    ]);
    const paneDiedHook = calls
      .map(withoutTmuxSocket)
      .find((call) => call[1] === "set-hook" && call.includes("pane-died"));
    expect(paneDiedHook?.slice(0, 8)).toEqual([
      "tmux",
      "set-hook",
      "-p",
      "-t",
      "%43",
      "pane-died",
      expect.stringContaining(GOVERNESS_PANE_DIED_SUBCOMMAND),
    ]);
    expect(paneDiedHook?.at(-1)).toContain(runDir);
    expect(paneDiedHook?.at(-1)).toContain("repo-loop-1");
    expect(paneDiedHook?.at(-1)).toContain("%43");
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-hook",
      "-R",
      "-p",
      "-t",
      "%43",
      "pane-died",
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "split-window",
      "-v",
      "-f",
      "-P",
      "-F",
      "#{pane_id}",
      "-l",
      "25%",
      "-t",
      "repo-loop-1:0",
      "-c",
      repoDir,
      expect.stringContaining("__recon-pane"),
    ]);
    expect(calls.map(withoutTmuxSocket)).toContainEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%45",
      "@loop_label",
      "activity.repo-loop-1",
    ]);
    expect(
      calls.filter(
        (call) =>
          tmuxCommand(call) === "split-window" &&
          call.some((arg) => arg.includes("__recon-pane"))
      )
    ).toHaveLength(1);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("the Nanny/Au Pair column defaults to the right fifth with an explicit opt-out", () => {
  expect(tmuxInternals.utilityPaneEnabled({})).toBe(true);
  expect(tmuxInternals.utilityPaneEnabled({ LOOP_UTILITY_PANE: "0" })).toBe(
    false
  );
  expect(tmuxInternals.utilityPaneEnabled({ LOOP_UTILITY_PANE: "off" })).toBe(
    false
  );
  expect(tmuxInternals.utilityPaneWidth({})).toBe("20%");
  expect(
    tmuxInternals.utilityPaneWidth({ LOOP_UTILITY_PANE_WIDTH: "20%" })
  ).toBe("20%");
  expect(
    tmuxInternals.utilityPaneWidth({ LOOP_UTILITY_PANE_HEIGHT: "18%" })
  ).toBe("18%");
  expect(
    tmuxInternals.utilityPaneWidth({ LOOP_UTILITY_PANE_WIDTH: "invalid" })
  ).toBe("20%");
  expect(tmuxInternals.reconPaneCount({})).toBe(1);
  expect(tmuxInternals.reconPaneCount({ LOOP_RECON_PANES: "0" })).toBe(0);
  expect(tmuxInternals.reconPaneCount({ LOOP_RECON_PANES: "2" })).toBe(1);
  expect(tmuxInternals.reconPaneCount({ LOOP_RECON_PANES: "9" })).toBe(1);
  expect(tmuxInternals.reconPaneHeight({})).toBe("25%");
  expect(tmuxInternals.reconPaneHeight({ LOOP_RECON_HEIGHT: "12%" })).toBe(
    "12%"
  );
});

test("governed layout preserves legacy numeric fallbacks without tmux stdout", async () => {
  const home = makeTempHome();
  const repoDir = join(home, "repo");
  const runDir = join(home, "run");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: repoDir,
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: join(runDir, "manifest.json"),
    repoId: "repo-123",
    runDir,
    runId: "1",
    storageRoot: join(home, "runs"),
    transcriptPath: join(runDir, "transcript.jsonl"),
  };
  const opts = makePairedOptions({
    agent: "oss",
    governess: true,
    governessCooldownSeconds: 300,
    governessHeight: "25%",
    governessIdleSeconds: 120,
    governessMaxRecoveries: 3,
    governessModel: "qwen-test",
    governessUrl: "http://127.0.0.1:8082",
    pairWith: "claude",
  });

  try {
    const delegated = await runInTmux(
      ["--tmux", "--governess", "--pair-with", "claude"],
      {
        capturePane: () => "\u276f ",
        cwd: repoDir,
        env: {},
        findBinary: () => true,
        getTerminalSize: () => undefined,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts, task: "Ship feature" }
    );

    expect(delegated).toBe(true);
    expect(manifest.tmuxPaneLeft).toBe("repo-loop-1:0.0");
    expect(manifest.tmuxPaneUtility).toBe("repo-loop-1:0.3");
    expect(manifest.tmuxPaneRight).toBe("repo-loop-1:0.1");
    expect(manifest.tmuxPaneGoverness).toBe("repo-loop-1:0.2");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux starts paired tmux panes for the OSS seat and Codex", async () => {
  const calls: string[][] = [];
  const proxyCalls: Array<{
    remoteUrl: string;
    runDir: string;
    threadId: string;
  }> = [];
  const startCalls: Array<{
    agent: string;
    kind?: string;
    sessionId?: string;
  }> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions({ pairWith: "oss" });
  const codexMcpConfigArgs = ["-c", 'mcp_servers.loop-bridge.command="loop"'];
  const codexRemoteUrl = "ws://127.0.0.1:4500";
  const codexProxyUrl = "ws://127.0.0.1:4600/";
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests", "--pair-with", "oss"],
    {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => codexRemoteUrl,
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = codexMcpConfigArgs;
        return { manifest, storage };
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: (
        runDir: string,
        remoteUrl: string,
        threadId: string
      ) => {
        proxyCalls.push({ remoteUrl, runDir, threadId });
        return Promise.resolve(codexProxyUrl);
      },
      startPersistentAgentSession: (agent, _opts, sessionId, _launch, kind) => {
        startCalls.push({ agent, kind, sessionId });
        return Promise.resolve(undefined);
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=1"];
  // Both panes share one tmux env list; the OSS config dir is a path, inert for
  // the Codex pane, and carries no credential.
  const ossEnv = [...env, "OPENCODE_CONFIG_DIR=/tmp/loop-oss-config"];
  const ossCommand = tmuxInternals.buildShellCommand([
    "env",
    ...ossEnv,
    ...tmuxInternals.buildOssCommand("openrouter/z-ai/glm-5.2"),
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...ossEnv,
    ...tmuxInternals.buildCodexCommand(
      codexProxyUrl,
      "test-model",
      codexMcpConfigArgs
    ),
  ]);

  expect(delegated).toBe(true);
  expect(proxyCalls).toEqual([
    {
      remoteUrl: codexRemoteUrl,
      runDir: storage.runDir,
      threadId: "codex-thread-1",
    },
  ]);
  expect(startCalls).toEqual([
    { agent: "codex", kind: "work", sessionId: undefined },
  ]);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-x",
    "220",
    "-y",
    "60",
    "-s",
    "repo-loop-1",
    "-c",
    "/repo",
    ossCommand,
  ]);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    "repo-loop-1:0.0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(
    calls.filter((call) => tmuxCommand(call) === "load-buffer")
  ).toHaveLength(2);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "paste-buffer",
    "-d",
    "-p",
    "-b",
    "repo-loop-1-oss-launch",
    "-t",
    "repo-loop-1:0.0",
  ]);
  expect(calls.map(withoutTmuxSocket)).toContainEqual([
    "tmux",
    "paste-buffer",
    "-d",
    "-p",
    "-b",
    "repo-loop-1-codex-launch",
    "-t",
    "repo-loop-1:0.1",
  ]);
  expect(manifest.claudeSessionId).toBe("");
  expect(manifest.codexRemoteUrl).toBe(codexRemoteUrl);
  expect(manifest.codexThreadId).toBe("codex-thread-1");
  expect(manifest.tmuxSession).toBe("repo-loop-1");
  expect(manifest.tmuxPaneLeftAgent).toBe("oss");
  expect(manifest.tmuxPaneRightAgent).toBe("codex");
});

test("runInTmux releases local codex app-server handles after paired handoff", async () => {
  const attaches: string[] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      attach: (session: string) => {
        attaches.push(session);
      },
      capturePane: (pane: string) =>
        pane.endsWith(":0.1") ? "Ctrl+J newline" : "❯ ",
      closePersistentCodexSession: () => {
        closed += 1;
        return Promise.resolve();
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      releasePersistentCodexSession: () => {
        released += 1;
      },
      sendKeys: (): void => undefined,
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "set-window-option") {
          throw new Error("tmux transport error");
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  expect(delegated).toBe(true);
  expect(attaches).toEqual(["repo-loop-1"]);
  expect(closed).toBe(0);
  expect(released).toBe(1);
});

test("runInTmux closes local Codex ownership without rewriting a completed manifest after attach", async () => {
  const attaches: string[] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let sessionAlive = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      attach: (session: string) => {
        attaches.push(session);
        manifest = setRunManifestState(manifest, "completed");
        sessionAlive = false;
      },
      capturePane: (pane: string) =>
        pane.endsWith(":0.1") ? "Ctrl+J newline" : "❯ ",
      closePersistentCodexSession: () => {
        closed += 1;
        return Promise.resolve();
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => true,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      releasePersistentCodexSession: () => {
        released += 1;
      },
      sendKeys: (): void => undefined,
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args.includes("has-session")) {
          return sessionAlive
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
          sessionAlive = true;
        }
        if (
          !sessionStarted &&
          args[0] === "tmux" &&
          tmuxCommand(args) === "split-window"
        ) {
          throw new Error("split before new-session");
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts, task: "Ship feature" }
  );

  expect(delegated).toBe(true);
  expect(attaches).toEqual(["repo-loop-1"]);
  expect(closed).toBe(1);
  expect(released).toBe(0);
  expect(manifest).toMatchObject({
    codexAppServerPid: undefined,
    codexRemoteUrl: undefined,
    state: "completed",
    status: "done",
  });
});

test("runInTmux starts paired interactive tmux panes without a task", async () => {
  const calls: string[][] = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions({ proof: "" });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      capturePane: () => "❯ ",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    { opts }
  );

  expect(delegated).toBe(true);
  expect(calls[0]).toEqual([
    "tmux",
    "-S",
    "/tmp/tmux-501/default",
    "has-session",
    "-t",
    "repo-loop-1",
  ]);
  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=1"];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    storage.repoId
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      false,
      undefined,
      undefined,
      join(storage.runDir, "claude-mcp.json")
    ),
  ]);
  expect(withoutTmuxSocket(calls[1] ?? [])).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-x",
    "220",
    "-y",
    "60",
    "-s",
    "repo-loop-1",
    "-c",
    "/repo",
    claudeCommand,
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand("ws://127.0.0.1:4600/", "test-model", [
      "-c",
      'mcp_servers.loop-bridge.command="loop"',
    ]),
  ]);
  expect(withoutTmuxSocket(calls[2] ?? [])).toEqual([
    "tmux",
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    "repo-loop-1:0.0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(typed).toEqual([]);
  expect(manifest.tmuxSession).toBe("repo-loop-1");
  expect(manifest.tmuxPaneLeftAgent).toBe("claude");
  expect(manifest.tmuxPaneRightAgent).toBe("codex");
});

test("runInTmux fails closed when Claude never reaches an input-ready prompt", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        capturePane: () => "",
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 4321,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (message): void => {
          logs.push(message);
        },
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions({ proof: "" }) }
    )
  ).rejects.toThrow(
    "Claude pane \"repo-loop-1:0.0\" did not reach an input-ready prompt within 20000ms. The live tmux session \"repo-loop-1\" was preserved; attach with: tmux -S '/tmp/tmux-501/default' attach -t 'repo-loop-1'"
  );

  expect(sleeps).toHaveLength(79);
  expect(sleeps.every((delay) => delay === 250)).toBe(true);
  expect(calls.some((args) => tmuxCommand(args) === "load-buffer")).toBe(false);
  expect(calls.some((args) => tmuxCommand(args) === "paste-buffer")).toBe(
    false
  );
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(manifest).toMatchObject({
    state: "input-required",
    status: "running",
    tmuxPaneLeft: "repo-loop-1:0.0",
    tmuxPaneRight: "repo-loop-1:0.1",
    tmuxSession: "repo-loop-1",
  });
  expect(released).toBe(1);
  expect(closed).toBe(0);
  expect(logs).toContain(
    "[loop] preserved live tmux session \"repo-loop-1\" for Claude startup readiness timeout recovery; attach with: tmux -S '/tmp/tmux-501/default' attach -t 'repo-loop-1'"
  );
});

test("runInTmux still terminalizes an unexpected Claude readiness probe failure", async () => {
  const calls: string[][] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let stoppedProxy = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        capturePane: () => {
          throw new Error("synthetic capture failure");
        },
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 4321,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        stopCodexProxy: (_proxyUrl, request) => {
          stoppedProxy += 1;
          expect(request).toEqual({
            caller: "paired-start-cleanup",
            requesterPid: process.pid,
          });
          expect(sessionStarted).toBe(false);
          expect(manifest).toMatchObject({
            state: "failed",
            status: "failed",
          });
          return Promise.resolve();
        },
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
          }
          if (args[0] === "tmux" && args.includes("kill-session")) {
            sessionStarted = false;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions({ proof: "" }) }
    )
  ).rejects.toThrow("synthetic capture failure");

  expect(closed).toBe(1);
  expect(stoppedProxy).toBe(1);
  expect(released).toBe(0);
  expect(
    calls.some((args) => args[0] === "tmux" && args.includes("kill-session"))
  ).toBe(true);
  expect(
    calls.filter((args) => args[0] === "tmux" && args.includes("kill-session"))
  ).toEqual([
    ["tmux", "-S", "/tmp/ls-a/a.sock", "kill-session", "-t", "repo-loop-1"],
  ]);
  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test.each([
  "nonzero-kill",
  "unknown-after-kill",
  "manifest-stays-active",
  "manifest-update-throws",
] as const)("runInTmux preserves exact recovery identity when failed-start cleanup is %s", async (cleanupFailure) => {
  let closed = 0;
  let postKillProbe = false;
  let released = 0;
  let sessionLive = false;
  let stoppedProxy = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        capturePane: () => {
          throw new Error("primary synthetic startup failure");
        },
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 4321,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        stopCodexProxy: () => {
          stoppedProxy += 1;
          return Promise.resolve();
        },
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && args.includes("has-session")) {
            if (postKillProbe) {
              return { exitCode: 1, stderr: "permission denied" };
            }
            return sessionLive
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionLive = true;
            return { exitCode: 0, stderr: "", stdout: "%91" };
          }
          if (args[0] === "tmux" && args.includes("kill-session")) {
            if (cleanupFailure === "nonzero-kill") {
              return { exitCode: 1, stderr: "permission denied" };
            }
            if (cleanupFailure === "unknown-after-kill") {
              postKillProbe = true;
            } else {
              sessionLive = false;
            }
            return { exitCode: 0, stderr: "" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          const next = update(manifest) ?? manifest;
          if (next.state === "failed") {
            if (cleanupFailure === "manifest-update-throws") {
              throw new Error("synthetic manifest write failure");
            }
            if (cleanupFailure === "manifest-stays-active") {
              return manifest;
            }
          }
          manifest = next;
          return manifest;
        },
      },
      { opts: makePairedOptions({ proof: "" }) }
    )
  ).rejects.toThrow("primary synthetic startup failure");

  expect(closed).toBe(0);
  expect(stoppedProxy).toBe(0);
  expect(released).toBe(1);
  expect(manifest.state).not.toBe("failed");
  expect(manifest).toMatchObject({
    codexAppServerPid: 4321,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "codex-thread-1",
    tmuxSession: "repo-loop-1",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
});

test("runInTmux fails closed and cleans up when the Claude kickoff is never confirmed", async () => {
  // The run-147 shape end to end: the pane reaches a ready-empty composer, the
  // launcher pastes and sends Enter, and no turn ever starts. The launch must
  // terminalize rather than report a running loop over a stranded kickoff.
  const strandedPane = readFileSync(
    join(
      import.meta.dir,
      "..",
      "fixtures",
      "claude-code",
      "2.1.223",
      "kickoff-channel-race",
      "02-stranded-kickoff-composer.txt"
    ),
    "utf8"
  );
  const calls: string[][] = [];
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let pasted = false;
  const enterKeys: string[] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        // Ready-empty until our own paste lands, then the captured stranded
        // composer from the real 2.1.223 producer.
        capturePane: () => (pasted ? strandedPane : "❯ "),
        claudeCliVersion: () => "2.1.223 (Claude Code)",
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 4321,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        // The hook journal never advances past SessionStart, exactly as the
        // preserved run-147 evidence records it.
        readClaudeTranscriptVersion: () => "",
        readTextFile: () =>
          '{"agent":"claude","event":"SessionStart","state":"starting","sequence":1}\n',
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (_pane: string, keys: string[]) => {
          enterKeys.push(...keys);
        },
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "paste-buffer") {
            pasted = true;
          }
          if (args[0] === "tmux" && args.includes("kill-session")) {
            sessionStarted = false;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions({ proof: "" }) }
    )
  ).rejects.toThrow("never started a turn from the launcher kickoff");

  // Zero survivors: the tmux session is killed and the owned Codex transport
  // is closed, and the manifest records the failure rather than a running loop.
  expect(
    calls.some((args) => args[0] === "tmux" && args.includes("kill-session"))
  ).toBe(true);
  expect(closed).toBe(1);
  expect(released).toBe(0);
  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
  expect(manifest.claudeCliVersion).toBe("2.1.223 (Claude Code)");
  // Exactly one recovery Enter, and no pane is ever pasted into twice: the
  // recovery re-sends a key, it never re-delivers the kickoff body.
  expect(enterKeys.filter((key) => key === "Enter")).toEqual(["Enter"]);
  const pastesPerPane = new Map<string, number>();
  for (const args of calls) {
    if (args[0] !== "tmux" || tmuxCommand(args) !== "paste-buffer") {
      continue;
    }
    const target = args[args.indexOf("-t") + 1] ?? "";
    pastesPerPane.set(target, (pastesPerPane.get(target) ?? 0) + 1);
  }
  // One paste for the Claude pane and one for its peer, neither repeated.
  expect(pastesPerPane.size).toBe(2);
  expect([...pastesPerPane.values()]).toEqual([1, 1]);
});

test("tmux prompts keep the paired review workflow explicit", () => {
  const opts = makePairedOptions();
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    "repo-123"
  );
  const primaryPrompt = tmuxInternals.buildPrimaryPrompt(
    "Ship feature",
    opts,
    "1",
    claudeChannelServer
  );
  const peerPrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "claude",
    "1",
    claudeChannelServer
  );

  expect(primaryPrompt).toContain("Agent-to-agent pair programming");
  expect(primaryPrompt).toContain("You are the main worker.");
  expect(primaryPrompt).toContain(
    "your own review and the peer review both pass"
  );
  expect(primaryPrompt).toContain(
    "Ask Claude for validation and feedback after every few concrete steps"
  );
  expect(primaryPrompt).toContain("Use AskUserQuestion");
  expect(primaryPrompt).toContain("Maintain `PLAN.md` and `status.md`");
  expect(primaryPrompt).toContain("running handoff");
  expect(primaryPrompt).toContain(
    "Context role: optimize for Codex's smaller context window."
  );
  expect(primaryPrompt).toContain("Ask Claude for missing historical context");
  expect(primaryPrompt).toContain(
    "create a draft PR or send a follow-up commit to the existing PR"
  );
  expect(primaryPrompt).not.toContain("Wait briefly if it arrives");
  expect(primaryPrompt).toContain('"mcp__loop_bridge__send_message"');
  expect(primaryPrompt).toContain("sole peer-delivery transport");
  expect(primaryPrompt).toContain("Human/founder/supervisor reporting:");
  expect(primaryPrompt).toContain("Make state visible immediately");
  expect(primaryPrompt).toContain("Internal agent communication:");
  expect(primaryPrompt).toContain("No arbitrary item cap applies");
  expect(primaryPrompt).toContain("commands/results");
  expect(primaryPrompt).toContain("Never duplicate a bridge body");
  expect(primaryPrompt).toContain("terminal nudge carries no message body");
  expect(primaryPrompt).toContain("Delegation is mandatory");
  expect(primaryPrompt).toContain('"mcp__loop_bridge__route_task"');
  expect(primaryPrompt).toContain("one to three independent bounded packets");
  expect(primaryPrompt).toContain("Use Nanny");
  expect(primaryPrompt).toContain("Use Au Pair");
  expect(primaryPrompt).toContain("Governess chooses the tier");
  expect(primaryPrompt).toContain("keep lower-tier work in flight");
  expect(primaryPrompt).toContain("Do not proactively create");
  expect(primaryPrompt).toContain("Use Direct, Nanny, and Au Pair first");
  expect(primaryPrompt).toContain("Governess lease");
  expect(primaryPrompt).not.toContain("Spawn a team of agents");
  expect(peerPrompt).toContain("You are the reviewer/support agent.");
  expect(peerPrompt).toContain("request validation every few concrete steps");
  expect(peerPrompt).toContain("keeps PLAN.md and status.md current");
  expect(peerPrompt).toContain(
    "Context role: use Claude's larger context window"
  );
  expect(peerPrompt).toContain(
    "Answer Codex context questions from session history"
  );
  expect(peerPrompt).toContain("Do not take over the task or create the PR");
  expect(peerPrompt).toContain("Wait for Codex to send you a targeted request");
  expect(peerPrompt).toContain(
    "the run task text is context, not an assignment"
  );
  expect(peerPrompt).toContain(
    "do not inspect task files, call repository tools, or route helper packets"
  );
  expect(primaryPrompt).not.toContain(
    "the run task text is context, not an assignment"
  );
  expect(peerPrompt).toContain("Delegation is mandatory");
  expect(peerPrompt).toContain("one to three independent bounded packets");
  expect(peerPrompt).toContain("Governess chooses the tier");
  expect(peerPrompt).toContain("sole peer-delivery transport");
  expect(peerPrompt).toContain("Human/founder/supervisor reporting:");
  expect(peerPrompt).toContain("Internal agent communication:");
  expect(peerPrompt).toContain("Separate observed facts from inference");
  expect(peerPrompt).not.toContain('"reply"');
  expect(peerPrompt).toContain(
    'Use "mcp__loop-bridge-repo-123-1__send_message" with target: "codex" for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.'
  );
  expect(primaryPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).toContain('"mcp__loop-bridge-repo-123-1__bridge_status"');
  expect(peerPrompt).toContain(
    '"mcp__loop-bridge-repo-123-1__receive_messages"'
  );
});

test("fresh paired charters bind and constrain the run World Model", () => {
  const opts = makePairedOptions();
  const worldModel = {
    capsuleSha256: "a".repeat(64),
    commitSha: "b".repeat(40),
    contextPath: "/tmp/run/world-model/bootstrap.json",
    contextSha256: "c".repeat(64),
    databasePath: "/tmp/run/world-model/project.sqlite",
    entityCount: 20,
    generatedAt: "2026-08-05T20:00:00.000Z",
    ontologyVersion: "0.1.0",
    seeds: ["src/entry.ts"],
    statementCount: 30,
  };

  for (const agent of ["codex", "claude"] as const) {
    const prompt = tmuxInternals.buildLaunchPrompt(
      { opts, task: "Ship feature" },
      agent,
      "1",
      "loop-bridge",
      worldModel
    );
    expect(prompt).toContain("Project World Model context is enabled");
    expect(prompt).toContain(worldModel.databasePath);
    expect(prompt).toContain(worldModel.contextPath);
    expect(prompt).toContain(worldModel.contextSha256);
    expect(prompt).toContain(worldModel.capsuleSha256);
    expect(prompt).toContain(worldModel.commitSha);
    expect(prompt).toContain("independently verify its file SHA-256");
    expect(prompt).toContain("cannot authorize routing");
  }
});

test("paired prompts apply Caveman guidance with an exact off switch", () => {
  const defaults = makePairedOptions();
  const primary = tmuxInternals.buildPrimaryPrompt(
    "Ship feature",
    defaults,
    "1",
    ""
  );
  const peer = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    defaults,
    "claude",
    "1",
    ""
  );
  expect(primary).toContain("CAVEMAN MODE ACTIVE — level: lite");
  expect(peer).toContain("CAVEMAN MODE ACTIVE — level: lite");
  expect(primary).toContain(
    "Preserve code, commands, paths, URLs, JSON, errors, SHAs"
  );

  const off = makePairedOptions({
    cavemanMode: "off",
    cavemanModeSource: "cli",
  });
  expect(
    tmuxInternals.buildInteractivePrimaryPrompt(off, "1", "")
  ).not.toContain("CAVEMAN MODE");
  expect(
    tmuxInternals.buildInteractivePeerPrompt(off, "claude", "1", "")
  ).not.toContain("CAVEMAN MODE");
});

test("tmux prompts make Claude the context steward and Codex recent-focused", () => {
  const opts = makePairedOptions({ agent: "claude", pairWith: "codex" });
  const primaryPrompt = tmuxInternals.buildPrimaryPrompt(
    "Ship feature",
    opts,
    "1",
    ""
  );
  const peerPrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "codex",
    "1",
    ""
  );

  expect(primaryPrompt).toContain("you are the primary Claude agent");
  expect(primaryPrompt).toContain(
    "Context role: use Claude's larger context window"
  );
  expect(primaryPrompt).toContain("Preserve historical decisions");
  expect(primaryPrompt).toContain("include the small recent slice");
  expect(primaryPrompt).toContain(
    "Answer Codex context questions from session history"
  );
  expect(peerPrompt).toContain("You are Codex.");
  expect(peerPrompt).toContain(
    "Context role: optimize for Codex's smaller context window."
  );
  expect(peerPrompt).toContain("Stay focused on the immediate request");
  expect(peerPrompt).toContain("Ask Claude for missing historical context");
  expect(peerPrompt).toContain("make frequent targeted calls");
});

test("tmux prompts respect --pair-with for non-default peers", () => {
  const opts = makePairedOptions({ pairWith: "cursor" });
  const primaryPrompt = tmuxInternals.buildPrimaryPrompt(
    "Ship feature",
    opts,
    "1",
    ""
  );
  const peerPrompt = tmuxInternals.buildPeerPrompt(
    "Ship feature",
    opts,
    "cursor",
    "1",
    ""
  );

  expect(primaryPrompt).toContain("Your peer is Cursor.");
  expect(primaryPrompt).toContain('with target: "cursor"');
  expect(primaryPrompt).toContain("Cursor reviews and helps on request.");
  expect(primaryPrompt).not.toContain("Your peer is Claude.");
  expect(peerPrompt).toContain("You are Cursor.");
  expect(peerPrompt).toContain('with target: "codex"');
  expect(peerPrompt).toContain("Wait for Codex to send you a targeted request");
});

test("interactive tmux prompts tell both agents to wait for the human", () => {
  const opts = makePairedOptions({ proof: "" });
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "1",
    "repo-123"
  );
  const primaryPrompt = tmuxInternals.buildInteractivePrimaryPrompt(
    opts,
    "1",
    claudeChannelServer
  );
  const peerPrompt = tmuxInternals.buildInteractivePeerPrompt(
    opts,
    "claude",
    "1",
    claudeChannelServer
  );

  expect(primaryPrompt).toContain("Agent-to-agent pair programming");
  expect(primaryPrompt).toContain("No task has been assigned yet.");
  expect(primaryPrompt).toContain("human-driven interactive run");
  expect(primaryPrompt).toContain("does not require a prewritten PLAN.md");
  expect(primaryPrompt).toContain("Wait for the first human task");
  expect(primaryPrompt).toContain("If the human asks for plan mode");
  expect(primaryPrompt).toContain("ask Claude for a plan review");
  expect(primaryPrompt).toContain("ask the human to review the plan");
  expect(primaryPrompt).toContain("use AskUserQuestion");
  expect(primaryPrompt).toContain("create or update PLAN.md and status.md");
  expect(primaryPrompt).toContain("end-of-session handoff");
  expect(primaryPrompt).toContain(
    "Context role: optimize for Codex's smaller context window."
  );
  expect(primaryPrompt).toContain(
    "Ask Claude for validation and feedback after every few concrete steps"
  );
  expect(primaryPrompt).toContain('"mcp__loop_bridge__send_message"');
  expect(primaryPrompt).toContain("do not proactively create");
  expect(primaryPrompt).toContain("Use Direct, Nanny, and Au Pair first");
  expect(primaryPrompt).not.toContain("Spawn a team of agents");
  expect(primaryPrompt).toContain("Human/founder/supervisor reporting:");
  expect(primaryPrompt).toContain("Internal agent communication:");
  expect(peerPrompt).toContain("No task has been assigned yet.");
  expect(peerPrompt).toContain("human-driven interactive run");
  expect(peerPrompt).toContain("keeps PLAN.md and status.md current");
  expect(peerPrompt).toContain(
    "Context role: use Claude's larger context window"
  );
  expect(peerPrompt).toContain(
    "If Codex asks for a plan review, review PLAN.md only"
  );
  expect(peerPrompt).toContain("Wait for Codex to provide a concrete task");
  expect(peerPrompt).toContain(
    "do not inspect task files, call repository tools, or route helper packets"
  );
  expect(peerPrompt).toContain("human clearly assigns you separate work");
  expect(peerPrompt).toContain("Human/founder/supervisor reporting:");
  expect(peerPrompt).toContain("Internal agent communication:");
  expect(peerPrompt).not.toContain('"reply"');
  expect(peerPrompt).toContain(
    'Use "mcp__loop-bridge-repo-123-1__send_message" with target: "codex" for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.'
  );
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).toContain('"mcp__loop-bridge-repo-123-1__bridge_status"');
  expect(peerPrompt).toContain(
    '"mcp__loop-bridge-repo-123-1__receive_messages"'
  );
  expect(peerPrompt).toContain(
    "If you are answering Codex, use the bridge tools instead of a human-facing reply."
  );
  expect(primaryPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
  expect(peerPrompt).not.toContain("mcp__loop-bridge-repo-123-1__ prefix");
});

test("runInTmux replays the captured Claude pre-connect warning before bootstrap", async () => {
  const calls: string[][] = [];
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  const states = [
    "bypass-default",
    "bypass-accepted",
    "development-channel",
    "ready-before-end-clear",
  ];
  const readyBefore = claudeWarningFixtureState("ready-before-end-clear");
  const readyAfter = claudeWarningFixtureState("ready-after-end-clear");
  const fallbackState = states.at(-1) ?? "ready-before-end-clear";
  let bootstrapStarted = false;
  let readyProbed = false;
  let screen = 0;
  let sessionStarted = false;
  const currentFrame = (): string => {
    if (bootstrapStarted && screen < states.length - 1) {
      throw new Error("bootstrap started before captured ready state");
    }
    return readClaudeWarningState(
      readyProbed ? "ready-after-end-clear" : (states[screen] ?? fallbackState)
    );
  };
  const currentFixtureState = (): ClaudeWarningFixtureFrame =>
    readyProbed
      ? readyAfter
      : claudeWarningFixtureState(states[screen] ?? fallbackState);
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      // Keep the text-only override so this exact test can run against the
      // pre-fix implementation as executable red-before evidence.
      capturePane: currentFrame,
      capturePaneSnapshot: () => {
        const frame = currentFixtureState();
        return {
          activeClients: frame.activeClients,
          cursor: frame.cursor,
          pipeOpen: frame.panePipe !== 0,
          text: currentFrame(),
          windowActivity: frame.windowActivity,
        };
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      nowMs: () => (readyBefore.windowActivity + 2) * 1000,
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
        if (pane !== "repo-loop-1:0.0") {
          return;
        }
        if (screen === 0 && keys[0] === "Down") {
          screen = 1;
        } else if (screen === 1 && keys[0] === "Enter") {
          screen = 2;
        } else if (screen === 2 && keys[0] === "Enter") {
          screen = 3;
        } else if (screen === 3 && keys.join(" ") === "End C-l") {
          readyProbed = true;
        }
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "load-buffer") {
          bootstrapStarted = true;
          expect(screen).toBe(3);
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls.slice(0, 3)).toEqual([
    { keys: ["Down"], pane: "repo-loop-1:0.0" },
    { keys: ["Enter"], pane: "repo-loop-1:0.0" },
    { keys: ["Enter"], pane: "repo-loop-1:0.0" },
  ]);
  expect(keyCalls.at(-1)).toEqual({
    keys: ["End", "C-l"],
    pane: "repo-loop-1:0.0",
  });
  expect(bootstrapStarted).toBe(true);
});

test("captured Claude suggestions are not ready without an active probe", () => {
  const readyFrame = readClaudeWarningState("ready-before-end-clear");
  const suggestion = readClaudeWarningComposer(readyFrame);
  expect(tmuxInternals.isClaudeInputReady(readyFrame)).toBe(false);
  expect(
    tmuxInternals.isClaudeInputReady(
      readyFrame.replace(
        suggestion,
        claudeWarningFixtureIndex.activityProbe.unsentDraft
      )
    )
  ).toBe(false);
});

test("Claude suggestion probe preserves and rejects a human Try draft", async () => {
  const draftFrame = readClaudeWarningState("draft-home");
  const draftHome = claudeWarningFixtureState("draft-home");
  const draftAfter = claudeWarningFixtureState("draft-after-end-clear");
  const draftRestored = claudeWarningFixtureState("draft-home-restored");
  let cursor = draftHome.cursor;
  let windowActivity = draftHome.windowActivity;
  let endCalls = 0;
  let homeCalls = 0;

  await expect(
    tmuxInternals.unblockClaudePane("%1", {
      capturePane: () => draftFrame,
      capturePaneSnapshot: () => ({
        activeClients: 0,
        cursor,
        pipeOpen: false,
        text: draftFrame,
        windowActivity,
      }),
      nowMs: () => (draftAfter.windowActivity + 2) * 1000,
      sendKeys: (_pane, keys) => {
        if (keys.join(" ") === "End C-l") {
          endCalls += 1;
          cursor = draftAfter.cursor;
          windowActivity = draftAfter.windowActivity;
        } else if (keys.join(" ") === "Home C-l") {
          homeCalls += 1;
          cursor = draftRestored.cursor;
          windowActivity = draftRestored.windowActivity;
        }
      },
      sleep: () => Promise.resolve(),
    })
  ).rejects.toThrow("contains unsent composer text");

  expect(endCalls).toBe(1);
  expect(homeCalls).toBe(1);
  expect(cursor).toEqual(draftRestored.cursor);
  expect(draftFrame).toContain(
    claudeWarningFixtureIndex.activityProbe.unsentDraft
  );
});

test("runInTmux preserves the live workspace when a post-End draft capture fails", async () => {
  const calls: string[][] = [];
  const draftHome = claudeWarningFixtureState("draft-home");
  const draftAfter = claudeWarningFixtureState("draft-after-end-clear");
  let current = draftHome;
  let captureFailed = false;
  let released = 0;
  let sessionStarted = false;
  const initialManifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  let storedManifest = initialManifest;
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };
  const paneText = () => readClaudeWarningFrame(current.normalizedFile);
  const snapshot = () =>
    captureFailed
      ? undefined
      : {
          activeClients: current.activeClients,
          cursor: current.cursor,
          pipeOpen: current.panePipe !== 0,
          text: paneText(),
          windowActivity: current.windowActivity,
        };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: paneText,
        capturePaneSnapshot: snapshot,
        closePersistentCodexSession: () => Promise.resolve(),
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        nowMs: () => (draftAfter.windowActivity + 2) * 1000,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest: storedManifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (pane, keys) => {
          if (pane !== "%0") {
            return;
          }
          if (keys.join(" ") === "End C-l") {
            current = draftAfter;
            captureFailed = true;
          }
        },
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
            return { exitCode: 0, stderr: "", stdout: "%0" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "split-window") {
            return { exitCode: 0, stderr: "", stdout: "%1" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          const updated = update(storedManifest);
          if (updated) {
            storedManifest = updated;
          }
          return updated;
        },
      },
      { opts: makePairedOptions(), task: "Ship feature" }
    )
  ).rejects.toThrow(
    "The live tmux session \"repo-loop-1\" was preserved; attach with: tmux -S '/tmp/tmux-501/default' attach -t 'repo-loop-1'"
  );

  expect(sessionStarted).toBe(true);
  expect(current.cursor).toEqual(draftAfter.cursor);
  expect(storedManifest.state).toBe("input-required");
  expect(storedManifest.tmuxPaneLeft).toBe("%0");
  expect(storedManifest.tmuxPaneRight).toBe("%1");
  expect(released).toBe(1);
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "load-buffer"
    )
  ).toBe(false);
});

test("tmux pane snapshots bind styled text and cursor in one payload", () => {
  const parsed = tmuxInternals.parseTmuxPaneSnapshot(
    "pane text\n__LOOP_PANE_CURSOR__ 2 16 1785474782 0 0\n"
  );
  expect(parsed).toEqual({
    activeClients: 0,
    cursor: { x: 2, y: 16 },
    pipeOpen: false,
    text: "pane text",
    windowActivity: 1_785_474_782,
  });
  expect(
    tmuxInternals.parseTmuxPaneSnapshot("pane text\nmissing cursor marker\n")
  ).toBeUndefined();
});

test("Claude suggestion probe requires an acknowledged redraw", async () => {
  const text = readClaudeWarningState("ready-before-end-clear");
  const ready = claudeWarningFixtureState("ready-before-end-clear");
  const snapshot = {
    activeClients: ready.activeClients,
    cursor: ready.cursor,
    pipeOpen: ready.panePipe !== 0,
    text,
    windowActivity: ready.windowActivity,
  };
  const keyCalls: string[][] = [];

  await expect(
    tmuxInternals.probeClaudeSuggestedComposer(
      "%1",
      snapshot,
      { row: ready.cursor.y, text: readClaudeWarningComposer(text) },
      {
        capturePaneSnapshot: () => snapshot,
        nowMs: () => (ready.windowActivity + 1) * 1000,
        sendKeys: (_pane, keys) => keyCalls.push(keys),
        sleep: () => Promise.resolve(),
      }
    )
  ).rejects.toThrow("state became unclassifiable after the cursor probe");

  expect(keyCalls).toEqual([["End", "C-l"]]);
});

test("Claude suggestion probe treats a send timeout as recoverable draft risk", async () => {
  const text = readClaudeWarningState("ready-before-end-clear");
  const ready = claudeWarningFixtureState("ready-before-end-clear");
  const snapshot = {
    activeClients: ready.activeClients,
    cursor: ready.cursor,
    pipeOpen: ready.panePipe !== 0,
    text,
    windowActivity: ready.windowActivity,
  };

  await expect(
    tmuxInternals.probeClaudeSuggestedComposer(
      "%1",
      snapshot,
      { row: ready.cursor.y, text: readClaudeWarningComposer(text) },
      {
        capturePaneSnapshot: () => snapshot,
        nowMs: () => (ready.windowActivity + 1) * 1000,
        sendKeys: () => {
          throw new Error("tmux send timed out after possible delivery");
        },
        sleep: () => Promise.resolve(),
      }
    )
  ).rejects.toThrow("tmux send timed out after possible delivery");
});

test("Claude suggestion probe rejects attached or piped panes", async () => {
  const text = readClaudeWarningState("ready-before-end-clear");
  const ready = claudeWarningFixtureState("ready-before-end-clear");
  const keyCalls: string[][] = [];
  const base = {
    cursor: ready.cursor,
    text,
    windowActivity: ready.windowActivity,
  };
  const deps = {
    capturePaneSnapshot: () => undefined,
    nowMs: () => (ready.windowActivity + 1) * 1000,
    sendKeys: (_pane: string, keys: string[]) => keyCalls.push(keys),
    sleep: () => Promise.resolve(),
  };

  expect(
    await tmuxInternals.probeClaudeSuggestedComposer(
      "%1",
      { ...base, activeClients: 1, pipeOpen: false },
      { row: ready.cursor.y, text: readClaudeWarningComposer(text) },
      deps
    )
  ).toBe("indeterminate");
  expect(
    await tmuxInternals.probeClaudeSuggestedComposer(
      "%1",
      { ...base, activeClients: 0, pipeOpen: true },
      { row: ready.cursor.y, text: readClaudeWarningComposer(text) },
      deps
    )
  ).toBe("indeterminate");
  expect(keyCalls).toEqual([]);
});

test("Claude suggestion probe waits across the activity second", async () => {
  const text = readClaudeWarningState("ready-before-end-clear");
  const ready = claudeWarningFixtureState("ready-before-end-clear");
  const readyAfter = claudeWarningFixtureState("ready-after-end-clear");
  let nowMs = ready.windowActivity * 1000;
  let windowActivity = ready.windowActivity;
  let sleeps = 0;
  const snapshot = () => ({
    activeClients: 0,
    cursor: ready.cursor,
    pipeOpen: false,
    text,
    windowActivity,
  });

  const result = await tmuxInternals.probeClaudeSuggestedComposer(
    "%1",
    snapshot(),
    { row: ready.cursor.y, text: readClaudeWarningComposer(text) },
    {
      capturePaneSnapshot: snapshot,
      nowMs: () => nowMs,
      sendKeys: () => {
        windowActivity = readyAfter.windowActivity;
      },
      sleep: (ms) => {
        sleeps += 1;
        nowMs += ms;
        return Promise.resolve();
      },
    }
  );

  expect(result).toBe("empty");
  expect(sleeps).toBeGreaterThanOrEqual(5);
});

test("Claude changed suggestions receive a fresh acknowledged probe", async () => {
  const first = readClaudeWarningState("ready-before-end-clear");
  const ready = claudeWarningFixtureState("ready-before-end-clear");
  const second = first.replace(
    readClaudeWarningComposer(first),
    'Try "explain this project"'
  );
  let text = first;
  let windowActivity = ready.windowActivity;
  let probes = 0;
  const snapshot = () => ({
    activeClients: 0,
    cursor: ready.cursor,
    pipeOpen: false,
    text,
    windowActivity,
  });

  await tmuxInternals.unblockClaudePane("%1", {
    capturePane: () => text,
    capturePaneSnapshot: snapshot,
    nowMs: () => (ready.windowActivity + 3) * 1000,
    sendKeys: (_pane, keys) => {
      if (keys.join(" ") !== "End C-l") {
        return;
      }
      probes += 1;
      windowActivity += 1;
      if (probes === 1) {
        text = second;
      }
    },
    sleep: () => Promise.resolve(),
  });

  expect(probes).toBe(2);
});

test("Claude draft probe restores Home and fails closed when activity acknowledgment is missing", async () => {
  const text = readClaudeWarningState("draft-home");
  const draftHome = claudeWarningFixtureState("draft-home");
  const draftAfter = claudeWarningFixtureState("draft-after-end-clear");
  let cursor = draftHome.cursor;
  const windowActivity = draftHome.windowActivity;
  let homeCalls = 0;
  const snapshot = () => ({
    activeClients: 0,
    cursor,
    pipeOpen: false,
    text,
    windowActivity,
  });

  const result = await tmuxInternals.probeClaudeSuggestedComposer(
    "%1",
    snapshot(),
    { row: draftHome.cursor.y, text: readClaudeWarningComposer(text) },
    {
      capturePaneSnapshot: snapshot,
      nowMs: () => (draftAfter.windowActivity + 3) * 1000,
      sendKeys: (_pane, keys) => {
        if (keys.join(" ") === "End C-l") {
          cursor = draftAfter.cursor;
          // Simulate the missing activity acknowledgment from the original
          // safety finding even though End moved a real draft's cursor.
        } else if (keys.join(" ") === "Home C-l") {
          homeCalls += 1;
          cursor = draftHome.cursor;
        }
      },
      sleep: () => Promise.resolve(),
    }
  );

  expect(result).toBe("draft-restore-unacknowledged");
  expect(homeCalls).toBe(1);
  expect(cursor).toEqual(draftHome.cursor);
  expect(windowActivity).toBe(draftHome.windowActivity);
});

test("runInTmux auto-confirms Claude startup prompts in paired mode", async () => {
  const calls: string[][] = [];
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  let startupStage: "bypass-accept" | "bypass-exit" | "dev" | "ready" = "dev";
  // Synthetic unit-only variant; producer-shape certification uses the captured fixture above.
  const syntheticDevChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "❯ 1. I am using this for local development",
  ].join("\n");
  const bypassExitPrompt = [
    "WARNING: Claude Code running in Bypass Permissions mode",
    "❯ 1. No, exit",
    "  2. Yes, I accept",
  ].join("\n");
  const bypassAcceptPrompt = [
    "WARNING: Claude Code running in Bypass Permissions mode",
    "  1. No, exit",
    "❯ 2. Yes, I accept",
  ].join("\n");
  const opts = makePairedOptions();
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        if (startupStage === "dev") {
          return syntheticDevChannelsPrompt;
        }
        if (startupStage === "bypass-exit") {
          return bypassExitPrompt;
        }
        return startupStage === "bypass-accept" ? bypassAcceptPrompt : "❯ ";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
        if (startupStage === "dev" && keys[0] === "Enter") {
          startupStage = "bypass-exit";
        } else if (startupStage === "bypass-exit" && keys[0] === "Down") {
          startupStage = "bypass-accept";
        } else if (startupStage === "bypass-accept" && keys[0] === "Enter") {
          startupStage = "ready";
        }
      },
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts, task: "Ship feature" }
  );

  expect(keyCalls[0]).toEqual({ keys: ["Enter"], pane: "repo-loop-1:0.0" });
  expect(keyCalls[1]).toEqual({
    keys: ["Down"],
    pane: "repo-loop-1:0.0",
  });
  expect(keyCalls[2]).toEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
  expect(
    keyCalls.some(
      (call) =>
        call.pane === "repo-loop-1:0.0" &&
        call.keys.length === 1 &&
        call.keys[0] === "Enter"
    )
  ).toBe(true);
  expect(
    keyCalls.some(
      (call) =>
        call.pane === "repo-loop-1:0.1" &&
        call.keys.length === 1 &&
        call.keys[0] === "Enter"
    )
  ).toBe(false);
  expect(typed).toEqual([]);
});

test("runInTmux confirms wrapped Claude dev-channel prompts", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let devChannelConfirmed = false;
  // Synthetic unit-only wrapping variant; it does not certify Claude's producer shape.
  const syntheticDevChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "❯ 1. I am using this for local",
    "development",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        return devChannelConfirmed ? "❯ " : syntheticDevChannelsPrompt;
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
        if (keys[0] === "Enter") {
          devChannelConfirmed = true;
        }
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("Claude dev-channel confirmation settles before retrying a swallowed key", async () => {
  const modal = [
    "Permission deny rule: stable startup warning",
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "❯ 1. I am using this for local development",
    "  2. Exit",
  ].join("\n");
  let elapsedMs = 0;
  let enterCalls = 0;
  let paneText = modal;
  let windowActivity = 100;
  const sentAt: number[] = [];

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: () => paneText,
    capturePaneSnapshot: () => ({
      activeClients: 0,
      cursor: { x: -1, y: -1 },
      pipeOpen: false,
      text: paneText,
      windowActivity,
    }),
    nowMs: () => elapsedMs,
    sendKeys: (_pane, keys) => {
      expect(keys).toEqual(["Enter"]);
      enterCalls += 1;
      sentAt.push(elapsedMs);
      if (enterCalls === 2) {
        paneText = "❯ ";
        windowActivity += 1;
      }
    },
    sleep: (ms) => {
      elapsedMs += ms;
      return Promise.resolve();
    },
  });

  expect(enterCalls).toBe(2);
  expect(sentAt).toEqual([1000, 2000]);
});

test("Claude dev-channel confirmation never retries after activity advances on a stale frame", async () => {
  const modal = [
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "❯ 1. I am using this for local development",
    "  2. Exit",
  ].join("\n");
  let elapsedMs = 0;
  let enterCalls = 0;
  let postSendCaptures = 0;

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: () => modal,
    capturePaneSnapshot: () => {
      if (enterCalls === 0) {
        return {
          activeClients: 0,
          cursor: { x: -1, y: -1 },
          pipeOpen: false,
          text: modal,
          windowActivity: 100,
        };
      }
      postSendCaptures += 1;
      return {
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text: postSendCaptures === 1 ? modal : "❯ ",
        windowActivity: 101,
      };
    },
    nowMs: () => elapsedMs,
    sendKeys: (_pane, keys) => {
      expect(keys).toEqual(["Enter"]);
      enterCalls += 1;
    },
    sleep: (ms) => {
      elapsedMs += ms;
      return Promise.resolve();
    },
  });

  expect(enterCalls).toBe(1);
  expect(postSendCaptures).toBe(2);
});

test("Claude dev-channel progress extends the readiness deadline past twenty seconds", async () => {
  const modal = [
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "❯ 1. I am using this for local development",
    "  2. Exit",
  ].join("\n");
  let confirmed = false;
  let elapsedMs = 0;
  const sentAt: number[] = [];
  const currentText = (): string => (confirmed ? "❯ " : modal);
  const currentActivity = (): number =>
    100 + Math.min(20, Math.floor(elapsedMs / 1000));

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: currentText,
    capturePaneSnapshot: () => ({
      activeClients: 0,
      cursor: { x: -1, y: -1 },
      pipeOpen: false,
      text: currentText(),
      windowActivity: currentActivity(),
    }),
    nowMs: () => elapsedMs,
    sendKeys: (_pane, keys) => {
      expect(keys).toEqual(["Enter"]);
      sentAt.push(elapsedMs);
      confirmed = true;
    },
    sleep: (ms) => {
      elapsedMs += ms;
      return Promise.resolve();
    },
  });

  expect(sentAt).toEqual([21_000]);
});

test("Claude dev-channel confirmation fails closed after bounded swallowed keys", async () => {
  const modal = [
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "❯ 1. I am using this for local development",
    "  2. Exit",
  ].join("\n");
  let elapsedMs = 0;
  let enterCalls = 0;

  await expect(
    tmuxInternals.unblockClaudePane("%0", {
      capturePane: () => modal,
      capturePaneSnapshot: () => ({
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text: modal,
        windowActivity: 100,
      }),
      nowMs: () => elapsedMs,
      sendKeys: (_pane, keys) => {
        expect(keys).toEqual(["Enter"]);
        enterCalls += 1;
      },
      sleep: (ms) => {
        elapsedMs += ms;
        return Promise.resolve();
      },
    })
  ).rejects.toThrow(
    "development-channel confirmation remained active after 3 positively detected attempts"
  );

  expect(enterCalls).toBe(3);
  expect(elapsedMs).toBe(4000);
});

test("Claude dev-channel confirmation waits through an incomplete modal redraw", async () => {
  const incompleteModal = [
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "  1. I am using this for local development",
    "  2. Exit",
  ].join("\n");
  const selectedModal = incompleteModal.replace(
    "  1. I am using",
    "❯ 1. I am using"
  );
  let captures = 0;
  let confirmed = false;
  let keyCalls = 0;

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: () => selectedModal,
    capturePaneSnapshot: () => {
      captures += 1;
      let text = selectedModal;
      if (confirmed) {
        text = "❯ ";
      } else if (captures <= 2) {
        text = incompleteModal;
      }
      return {
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text,
        windowActivity: captures <= 2 ? 100 : 101,
      };
    },
    nowMs: () => 0,
    sendKeys: (_pane, keys) => {
      expect(keys).toEqual(["Enter"]);
      keyCalls += 1;
      confirmed = true;
    },
    sleep: () => Promise.resolve(),
  });

  expect(keyCalls).toBe(1);
});

test("Claude dev-channel confirmation never enters when exit is selected", async () => {
  const modal = [
    "WARNING: Loading development channels",
    "--dangerously-load-development-channels is for local channel development only.",
    "  1. I am using this for local development",
    "❯ 2. Exit",
  ].join("\n");
  let keyCalls = 0;

  await expect(
    tmuxInternals.unblockClaudePane("%0", {
      capturePane: () => modal,
      capturePaneSnapshot: () => ({
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text: modal,
        windowActivity: 100,
      }),
      nowMs: () => Date.now(),
      sendKeys: () => {
        keyCalls += 1;
      },
      sleep: () => Promise.resolve(),
    })
  ).rejects.toThrow(
    "development-channel exit option was selected; refused to send Enter"
  );

  expect(keyCalls).toBe(0);
});

test("Claude dev-channel confirmation ignores a stale modal above the current composer", async () => {
  const paneText = [
    "WARNING: Loading development channels",
    "❯ 1. I am using this for local development",
    "  2. Exit",
    "",
    "❯ ",
  ].join("\n");
  let keyCalls = 0;

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: () => paneText,
    capturePaneSnapshot: () => ({
      activeClients: 0,
      cursor: { x: 2, y: 4 },
      pipeOpen: false,
      text: paneText,
      windowActivity: 101,
    }),
    nowMs: () => Date.now(),
    sendKeys: () => {
      keyCalls += 1;
    },
    sleep: () => Promise.resolve(),
  });

  expect(keyCalls).toBe(0);
});

test("Claude bypass confirmation never enters when navigation is swallowed", async () => {
  const modal = [
    "Bypass Permissions mode",
    "❯ 1. No, exit",
    "  2. Yes, I accept",
  ].join("\n");
  const keys: string[][] = [];

  await expect(
    tmuxInternals.unblockClaudePane("%0", {
      capturePane: () => modal,
      capturePaneSnapshot: () => ({
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text: modal,
        windowActivity: 100,
      }),
      nowMs: () => 0,
      sendKeys: (_pane, sentKeys) => keys.push(sentKeys),
      sleep: () => Promise.resolve(),
    })
  ).rejects.toThrow(
    "bypass-permissions confirmation did not reach a verified next state"
  );

  expect(keys).toEqual([["Down"]]);
});

test("Claude bypass confirmation enters only after a fresh selected-accept capture", async () => {
  const exitSelected = [
    "Bypass Permissions mode",
    "❯ 1. No, exit",
    "  2. Yes, I accept",
  ].join("\n");
  const acceptSelected = [
    "Bypass Permissions mode",
    "  1. No, exit",
    "❯ 2. Yes, I accept",
  ].join("\n");
  const keys: string[][] = [];
  let stage: "accept" | "exit" | "ready" = "exit";
  const currentText = (): string => {
    if (stage === "exit") {
      return exitSelected;
    }
    return stage === "accept" ? acceptSelected : "❯ ";
  };

  await tmuxInternals.unblockClaudePane("%0", {
    capturePane: currentText,
    capturePaneSnapshot: () => ({
      activeClients: 0,
      cursor: { x: -1, y: -1 },
      pipeOpen: false,
      text: currentText(),
      windowActivity: stage === "exit" ? 100 : 101,
    }),
    nowMs: () => 0,
    sendKeys: (_pane, sentKeys) => {
      keys.push(sentKeys);
      if (sentKeys[0] === "Down") {
        stage = "accept";
      } else if (sentKeys[0] === "Enter") {
        stage = "ready";
      }
    },
    sleep: () => Promise.resolve(),
  });

  expect(keys).toEqual([["Down"], ["Enter"]]);
});

test("runInTmux catches a delayed Claude dev-channel prompt", async () => {
  const calls: string[][] = [];
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  let delayedDevChannelConfirmed = false;
  // Synthetic unit-only delay variant; it does not certify Claude's producer shape.
  const syntheticDevChannelsPrompt = [
    "WARNING: Loading development channels",
    "",
    "--dangerously-load-development-channels is for local channel development only.",
    "",
    "❯ 1. I am using this for local development",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (calls.some((args) => tmuxCommand(args) === "load-buffer")) {
          throw new Error(
            "bootstrap transport started before Claude was ready"
          );
        }
        if (pollCount < 5) {
          return "Permission deny rule: stable startup warning";
        }
        if (!delayedDevChannelConfirmed) {
          return `❯\n\n${syntheticDevChannelsPrompt}`;
        }
        return "❯ ";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
        if (keys[0] === "Enter") {
          delayedDevChannelConfirmed = true;
        }
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
  expect(
    keyCalls.filter(
      (call) => call.pane === "repo-loop-1:0.0" && call.keys[0] === "Enter"
    )
  ).toHaveLength(1);
  expect(calls.some((args) => tmuxCommand(args) === "load-buffer")).toBe(true);
});

test("runInTmux confirms the current Claude bypass prompt wording", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let stage: "accept" | "exit" | "ready" = "exit";
  const bypassExitPrompt = [
    "Bypass Permissions mode",
    "",
    "❯ 1. No, exit",
    "  2. Yes, I accept",
  ].join("\n");
  const bypassAcceptPrompt = [
    "Bypass Permissions mode",
    "",
    "  1. No, exit",
    "❯ 2. Yes, I accept",
  ].join("\n");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        if (stage === "exit") {
          return bypassExitPrompt;
        }
        return stage === "accept" ? bypassAcceptPrompt : "❯ ";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
        if (keys[0] === "Down") {
          stage = "accept";
        } else if (keys[0] === "Enter") {
          stage = "ready";
        }
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Down"],
    pane: "repo-loop-1:0.0",
  });
  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux still confirms Claude trust prompts in paired mode", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount === 1) {
          return "Is this a project you created or one you trust?";
        }
        return "❯ ";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux still catches a delayed Claude trust prompt", async () => {
  const keyCalls: Array<{ keys: string[]; pane: string }> = [];
  let sessionStarted = false;
  let pollCount = 0;
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await runInTmux(
    ["--tmux", "--proof", "verify with tests"],
    {
      capturePane: () => {
        pollCount += 1;
        if (pollCount < 4) {
          return "Permission deny rule: stable startup warning";
        }
        if (pollCount === 4) {
          return "Is this a project you created or one you trust?";
        }
        return "❯ ";
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
      getLastCodexThreadId: () => "codex-thread-1",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "claude-session-1",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = [
          "-c",
          'mcp_servers.loop-bridge.command="loop"',
        ];
        return { manifest, storage };
      },
      sendKeys: (pane: string, keys: string[]) => {
        keyCalls.push({ keys, pane });
      },
      sendText: (): void => undefined,
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts: makePairedOptions(), task: "Ship feature" }
  );

  expect(keyCalls).toContainEqual({
    keys: ["Enter"],
    pane: "repo-loop-1:0.0",
  });
});

test("runInTmux reopens paired tmux panes without replaying the task", async () => {
  const calls: string[][] = [];
  const typed: Array<{ pane: string; text: string }> = [];
  let sessionStarted = false;
  const opts = makePairedOptions();
  const codexMcpConfigArgs = ["-c", 'mcp_servers.loop-bridge.command="loop"'];
  const codexRemoteUrl = "ws://127.0.0.1:4500";
  const codexProxyUrl = "ws://127.0.0.1:4600/";
  const manifest = createRunManifest({
    claudeSessionId: "claude-session-1",
    codexThreadId: "codex-thread-1",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "alpha",
    status: "running",
  });
  const storage = {
    manifestPath: "/repo/.loop/runs/alpha/manifest.json",
    repoId: "repo-123",
    runDir: "/repo/.loop/runs/alpha",
    runId: "alpha",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/alpha/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify with tests"],
    {
      capturePane: () => "❯ ",
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      getCodexAppServerUrl: () => codexRemoteUrl,
      getLastCodexThreadId: () => "",
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      makeClaudeSessionId: () => "unused",
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: (nextOpts) => {
        nextOpts.codexMcpConfigArgs = codexMcpConfigArgs;
        return { manifest, storage };
      },
      sendKeys: (): void => undefined,
      sendText: (pane: string, text: string) => {
        typed.push({ pane, text });
      },
      sleep: () => Promise.resolve(),
      startCodexProxy: () => Promise.resolve(codexProxyUrl),
      startPersistentAgentSession: () => Promise.resolve(undefined),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => update(manifest),
    },
    { opts, task: "Ship feature" }
  );

  const env = ["LOOP_RUN_BASE=repo", "LOOP_RUN_ID=alpha"];
  const claudeChannelServer = tmuxInternals.buildClaudeChannelServerName(
    "alpha",
    storage.repoId
  );
  const claudeCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      claudeChannelServer,
      true,
      undefined,
      undefined,
      join(storage.runDir, "claude-mcp.json")
    ),
  ]);
  const codexCommand = tmuxInternals.buildShellCommand([
    "env",
    ...env,
    ...tmuxInternals.buildCodexCommand(
      codexProxyUrl,
      "test-model",
      codexMcpConfigArgs
    ),
  ]);

  expect(delegated).toBe(true);
  expect(withoutTmuxSocket(calls[1] ?? [])).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-x",
    "220",
    "-y",
    "60",
    "-s",
    "repo-loop-alpha",
    "-c",
    "/repo",
    claudeCommand,
  ]);
  expect(withoutTmuxSocket(calls[2] ?? [])).toEqual([
    "tmux",
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    "repo-loop-alpha:0.0",
    "-c",
    "/repo",
    codexCommand,
  ]);
  expect(typed).toEqual([]);
});

test("runInTmux resolves paired run id through an existing manifest", async () => {
  await withTempHomeRunManifest("alpha", async (home) => {
    const calls: string[][] = [];
    const attaches: string[] = [];
    let sessionStarted = false;
    const runBase = currentRunBase(process.cwd(), "alpha");
    const session = tmuxInternals.buildRunName(runBase, "alpha");
    const command = tmuxInternals.buildShellCommand([
      "env",
      `LOOP_RUN_BASE=${runBase}`,
      "LOOP_RUN_ID=alpha",
      "bun",
      "/repo/src/cli.ts",
      "--run-id",
      "alpha",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      ["--tmux", "--run-id", "alpha", "--proof", "verify"],
      {
        attach: (session: string) => {
          attaches.push(session);
        },
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        getTerminalSize: () => undefined,
        isInteractive: () => true,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && args.includes("new-session")) {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "new-session",
        "-s",
        session,
        "-d",
        "-c",
        process.cwd(),
        command,
      ],
      ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "set-window-option",
        "-t",
        `${session}:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
    expect(attaches).toEqual([session]);
  });
});

test("runInTmux rejects unknown run id before starting tmux session", async () => {
  const calls: string[][] = [];
  const home = makeTempHome();

  try {
    await expect(
      runInTmux(["--tmux", "--run-id", "typo", "--proof", "verify"], {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        log: (): void => undefined,
        spawn: (args: string[]) => {
          calls.push(args);
          return { exitCode: 0, stderr: "" };
        },
      })
    ).rejects.toThrow('[loop] paired run "typo" does not exist');
    expect(calls).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux honors paired run resume from --session", async () => {
  await withTempHomeRunManifest("alpha", async (home) => {
    const calls: string[][] = [];
    let sessionStarted = false;
    const runBase = currentRunBase(process.cwd(), "alpha");
    const session = tmuxInternals.buildRunName(runBase, "alpha");
    const command = tmuxInternals.buildShellCommand([
      "env",
      `LOOP_RUN_BASE=${runBase}`,
      "LOOP_RUN_ID=alpha",
      "bun",
      "/repo/src/cli.ts",
      "--session",
      "alpha",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      ["--tmux", "--session", "alpha", "--proof", "verify"],
      {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && args.includes("new-session")) {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "new-session",
        "-s",
        session,
        "-d",
        "-c",
        process.cwd(),
        command,
      ],
      ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "set-window-option",
        "-t",
        `${session}:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
  });
});

test("runInTmux resolves paired resume from a worktree using git common dir", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = "repo";
  const session = tmuxInternals.buildRunName(runBase, "alpha");
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=alpha",
    "bun",
    "/repo/src/cli.ts",
    "--run-id",
    "alpha",
    "--proof",
    "verify",
  ]);

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo-loop-alpha",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
      runGit: (_cwd: string, args: string[]) => {
        if (
          args.join(" ") === "rev-parse --path-format=absolute --git-common-dir"
        ) {
          return { exitCode: 0, stderr: "", stdout: "/repo/.git\n" };
        }
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args.includes("has-session")) {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && args.includes("new-session")) {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls).toEqual([
    ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "new-session",
      "-s",
      session,
      "-d",
      "-c",
      "/repo-loop-alpha",
      command,
    ],
    ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "set-window-option",
      "-t",
      `${session}:0`,
      "remain-on-exit",
      "on",
    ],
  ]);
});

test("runInTmux strips a worktree suffix when git metadata is unavailable", async () => {
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = "repo";
  const session = tmuxInternals.buildRunName(runBase, "alpha");
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=alpha",
    "bun",
    "/repo/src/cli.ts",
    "--run-id",
    "alpha",
    "--proof",
    "verify",
  ]);

  const delegated = await runInTmux(
    ["--tmux", "--run-id", "alpha", "--proof", "verify"],
    {
      cwd: "/repo-loop-alpha",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      launchArgv: ["bun", "/repo/src/cli.ts"],
      log: (): void => undefined,
      resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
      runGit: (
        _cwd: string,
        _args: string[]
      ): { exitCode: number; stderr: string; stdout: string } => ({
        exitCode: 1,
        stderr: "",
        stdout: "",
      }),
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && args.includes("has-session")) {
          return sessionStarted
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        if (args[0] === "tmux" && args.includes("new-session")) {
          sessionStarted = true;
        }
        return { exitCode: 0, stderr: "" };
      },
    }
  );

  expect(delegated).toBe(true);
  expect(calls).toEqual([
    ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "new-session",
      "-s",
      session,
      "-d",
      "-c",
      "/repo-loop-alpha",
      command,
    ],
    ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
    [
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "set-window-option",
      "-t",
      `${session}:0`,
      "remain-on-exit",
      "on",
    ],
  ]);
});

test("runInTmux resolves raw stored session ids from --session", async () => {
  await withTempHomeRunManifest(
    "alpha",
    async (home) => {
      const calls: string[][] = [];
      let sessionStarted = false;
      const runBase = currentRunBase(process.cwd(), "alpha");
      const session = tmuxInternals.buildRunName(runBase, "alpha");
      const command = tmuxInternals.buildShellCommand([
        "env",
        `LOOP_RUN_BASE=${runBase}`,
        "LOOP_RUN_ID=alpha",
        "bun",
        "/repo/src/cli.ts",
        "--session",
        "claude-session-1",
        "--proof",
        "verify",
      ]);

      const delegated = await runInTmux(
        ["--tmux", "--session", "claude-session-1", "--proof", "verify"],
        {
          cwd: process.cwd(),
          env: { HOME: home },
          findBinary: () => true,
          isInteractive: () => false,
          launchArgv: ["bun", "/repo/src/cli.ts"],
          log: (): void => undefined,
          resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
          spawn: (args: string[]) => {
            calls.push(args);
            if (args[0] === "tmux" && args.includes("has-session")) {
              return sessionStarted
                ? { exitCode: 0, stderr: "" }
                : { exitCode: 1, stderr: "session not found" };
            }
            if (args[0] === "tmux" && args.includes("new-session")) {
              sessionStarted = true;
            }
            return { exitCode: 0, stderr: "" };
          },
        }
      );

      expect(delegated).toBe(true);
      expect(calls).toEqual([
        ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
        [
          "tmux",
          "-S",
          "/tmp/ls-a/a.sock",
          "new-session",
          "-s",
          session,
          "-d",
          "-c",
          process.cwd(),
          command,
        ],
        ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", session],
        [
          "tmux",
          "-S",
          "/tmp/ls-a/a.sock",
          "set-window-option",
          "-t",
          `${session}:0`,
          "remain-on-exit",
          "on",
        ],
      ]);
    },
    { claudeSessionId: "claude-session-1" }
  );
});

test("runInTmux ignores an unresolved raw session id in paired mode", async () => {
  const home = makeTempHome();
  const calls: string[][] = [];
  let sessionStarted = false;
  const runBase = currentRunBase(process.cwd(), "1");
  const command = tmuxInternals.buildShellCommand([
    "env",
    `LOOP_RUN_BASE=${runBase}`,
    "LOOP_RUN_ID=1",
    "bun",
    "/repo/src/cli.ts",
    "--session",
    "claude-session-raw",
    "--proof",
    "verify",
  ]);

  try {
    const delegated = await runInTmux(
      ["--tmux", "--session", "claude-session-raw", "--proof", "verify"],
      {
        cwd: process.cwd(),
        env: { HOME: home },
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && args.includes("new-session")) {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "new-session",
        "-s",
        `${runBase}-loop-1`,
        "-d",
        "-c",
        process.cwd(),
        command,
      ],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "has-session",
        "-t",
        `${runBase}-loop-1`,
      ],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "set-window-option",
        "-t",
        `${runBase}-loop-1:0`,
        "remain-on-exit",
        "on",
      ],
    ]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("runInTmux keeps raw --session values in single-agent mode", async () => {
  const onlyModes = ["--claude-only", "--codex-only"] as const;

  for (const onlyMode of onlyModes) {
    const calls: string[][] = [];
    let sessionStarted = false;
    const command = tmuxInternals.buildShellCommand([
      "env",
      "LOOP_RUN_BASE=repo",
      "LOOP_RUN_ID=1",
      "bun",
      "/repo/src/cli.ts",
      onlyMode,
      "--session",
      "claude-session-1",
      "--proof",
      "verify",
    ]);

    const delegated = await runInTmux(
      [
        "--tmux",
        onlyMode,
        "--session",
        "claude-session-1",
        "--proof",
        "verify",
      ],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && args.includes("new-session")) {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
      }
    );

    expect(delegated).toBe(true);
    expect(calls).toEqual([
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "new-session",
        "-s",
        "repo-loop-1",
        "-d",
        "-c",
        "/repo",
        command,
      ],
      ["tmux", "-S", "/tmp/ls-a/a.sock", "has-session", "-t", "repo-loop-1"],
      [
        "tmux",
        "-S",
        "/tmp/ls-a/a.sock",
        "set-window-option",
        "-t",
        "repo-loop-1:0",
        "remain-on-exit",
        "on",
      ],
    ]);
  }
});

test("runInTmux increments session index on conflicts", async () => {
  const calls: string[][] = [];
  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    attach: (): void => undefined,
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => false,
    resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
    spawn: (args: string[]) => {
      calls.push(args);
      const name = args[5];
      if (name === "repo-loop-1") {
        return { exitCode: 1, stderr: "duplicate session: repo-loop-1" };
      }
      if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
        return { exitCode: 0, stderr: "" };
      }
      return { exitCode: 0, stderr: "" };
    },
  });

  expect(delegated).toBe(true);
  expect(calls[0]?.slice(0, 6)).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "new-session",
    "-s",
    "repo-loop-1",
  ]);
  expect(calls[1]?.slice(0, 6)).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "new-session",
    "-s",
    "repo-loop-2",
  ]);
  expect(calls[2]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "has-session",
    "-t",
    "repo-loop-2",
  ]);
  expect(calls[3]).toEqual([
    "tmux",
    "-S",
    "/tmp/ls-a/a.sock",
    "set-window-option",
    "-t",
    "repo-loop-2:0",
    "remain-on-exit",
    "on",
  ]);
});

test("runInTmux surfaces tmux startup errors", async () => {
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: () => ({ exitCode: 1, stderr: "boom" }),
    })
  ).rejects.toThrow("Failed to start tmux session: boom");
});

test("runInTmux fails nonzero when the tmux control plane times out", async () => {
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: () => ({
        exitCode: 124,
        stderr: "tmux control command timed out after 2000ms",
        timedOut: true,
      }),
    })
  ).rejects.toThrow(
    "Failed to start tmux session: tmux control command timed out after 2000ms"
  );
});

test("runInTmux refuses success when post-launch session liveness is unknown", async () => {
  let calls = 0;
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      spawn: () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "" }
          : {
              exitCode: 124,
              stderr: "tmux control command timed out after 2000ms",
              timedOut: true,
            };
      },
    })
  ).rejects.toThrow(
    'tmux control command timed out after 2000ms while checking session "repo-loop-1"'
  );
});

test("runInTmux keeps named-socket-missing non-paired handoff liveness unknown", async () => {
  let calls = 0;
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
      spawn: () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "" }
          : {
              exitCode: 1,
              stderr:
                "error connecting to /tmp/ls-a/a.sock (No such file or directory)",
            };
      },
    })
  ).rejects.toThrow('tmux session "repo-loop-1" liveness is unknown');
  expect(calls).toBe(2);
});

test("runInTmux keeps unrelated nonzero handoff stderr unknown", async () => {
  let calls = 0;
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never,
      spawn: () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "" }
          : { exitCode: 1, stderr: "permission denied" };
      },
    })
  ).rejects.toThrow('tmux session "repo-loop-1" liveness is unknown');
  expect(calls).toBe(2);
});

test("runInTmux preserves paired probe argv byte-for-byte with a launch socket available", async () => {
  const calls: string[][] = [];
  let manifestUpdates = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        resolveLaunchSocket: () => "/tmp/decoy-launch.sock" as never,
        spawn: (args: string[]) => {
          calls.push(args);
          return { exitCode: 1, stderr: "permission denied" };
        },
        updateRunManifest: (_path, update) => {
          manifestUpdates += 1;
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Ship feature",
      }
    )
  ).rejects.toThrow(
    'tmux session "repo-loop-1" liveness is unknown; refusing handoff or terminalization: permission denied'
  );

  expect(calls).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/decoy-launch.sock",
      "has-session",
      "-t",
      "repo-loop-1",
    ],
  ]);
  expect(manifestUpdates).toBe(2);
  expect(manifest).toMatchObject({
    state: "submitted",
    status: "running",
    tmuxSession: "repo-loop-1",
    tmuxSocket: "/tmp/decoy-launch.sock",
  });
});

test.each([
  [
    "timeout",
    {
      exitCode: 124,
      stderr: "tmux control command timed out after 2000ms",
      timedOut: true,
    },
    'tmux control command timed out after 2000ms while checking session "repo-loop-1"',
  ],
  [
    "unrecognized nonzero",
    { exitCode: 1, stderr: "permission denied" },
    'tmux session "repo-loop-1" liveness is unknown; refusing handoff or terminalization: permission denied',
  ],
] as const)("runInTmux preserves current transport and active state on paired %s liveness", async (_label, unknownResult, expectedError) => {
  let closed = 0;
  let released = 0;
  let sessionStarted = false;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: () => "❯ ",
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 45_000,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return sessionStarted
              ? unknownResult
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionStarted = true;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions(), task: "Ship feature" }
    )
  ).rejects.toThrow(expectedError);

  expect(closed).toBe(0);
  expect(released).toBe(1);
  expect(manifest).toMatchObject({
    codexAppServerPid: 45_000,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    state: "submitted",
    status: "running",
  });
});

test("runInTmux preserves current transport and active state when paired layout outcome is unknown", async () => {
  const calls: string[][] = [];
  let closed = 0;
  let layoutTimedOut = false;
  let released = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: () => "",
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 45_000,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        releasePersistentCodexSession: () => {
          released += 1;
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return layoutTimedOut
              ? {
                  exitCode: 124,
                  stderr: "tmux control command timed out after 2000ms",
                  timedOut: true,
                }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            layoutTimedOut = true;
            return {
              exitCode: 124,
              stderr: "tmux control command timed out after 2000ms",
              timedOut: true,
            };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions(), task: "Ship feature" }
    )
  ).rejects.toThrow(
    'tmux control command timed out after 2000ms while checking session "repo-loop-1"'
  );

  expect(closed).toBe(0);
  expect(released).toBe(1);
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(manifest).toMatchObject({
    codexAppServerPid: 45_000,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    state: "submitted",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
});

test("runInTmux never mutates home Claude MCP registration on startup failure", async () => {
  const calls: string[][] = [];
  let closed = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    status: "running",
  });
  const opts = makePairedOptions();
  const storage = {
    manifestPath: "/repo/.loop/runs/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/repo/.loop/runs",
    transcriptPath: "/repo/.loop/runs/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: () => "",
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-1",
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        makeClaudeSessionId: () => "claude-session-1",
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            return { exitCode: 1, stderr: "boom" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts, task: "Ship feature" }
    )
  ).rejects.toThrow("Failed to start tmux session: boom");

  expect(
    calls.some((args) => args[0] === "claude" && tmuxCommand(args) === "mcp")
  ).toBe(false);
  expect(
    calls
      .find((args) => args[0] === "tmux" && tmuxCommand(args) === "new-session")
      ?.at(-1)
  ).toContain("--strict-mcp-config");
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(closed).toBe(1);
  expect(manifest).toMatchObject({
    codexAppServerPid: undefined,
    codexRemoteUrl: undefined,
    state: "failed",
    status: "failed",
    tmuxPaneLeftAgent: "claude",
    tmuxPaneRightAgent: "codex",
    tmuxSession: "repo-loop-1",
  });
});

test("runInTmux terminalizes a hook-preparation failure before new-session", async () => {
  const calls: string[][] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    // Bound by the launch reservation before this launch began (T-04 phase 1).
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const parent = makeTempRunDir();
  const blockedRunDir = join(parent, "not-a-directory");
  writeFileSync(blockedRunDir, "fixture", "utf8");
  const storage = {
    manifestPath: join(blockedRunDir, "manifest.json"),
    repoId: "repo-123",
    runDir: blockedRunDir,
    runId: "1",
    storageRoot: parent,
    transcriptPath: join(blockedRunDir, "transcript.jsonl"),
  };

  try {
    await expect(
      runInTmux(
        ["--tmux", "--proof", "verify with tests"],
        {
          cwd: "/repo",
          env: {},
          findBinary: () => true,
          isInteractive: () => false,
          log: (): void => undefined,
          ...healthyClaudeKickoffDeps(),
          preparePairedRun: () => ({ manifest, storage }),
          spawn: (args: string[]) => {
            calls.push(args);
            return args[0] === "tmux" && tmuxCommand(args) === "has-session"
              ? { exitCode: 1, stderr: "session not found" }
              : { exitCode: 0, stderr: "" };
          },
          updateRunManifest: (_path, update) => {
            manifest = update(manifest) ?? manifest;
            return manifest;
          },
        },
        {
          opts: makePairedOptions({
            agent: "gemini",
            governess: true,
            pairWith: "cursor",
          }),
          task: "Ship feature",
        }
      )
    ).rejects.toThrow();
    expect(
      calls.some(
        (args) => args[0] === "tmux" && tmuxCommand(args) === "new-session"
      )
    ).toBe(false);
    expect(manifest).toMatchObject({ state: "failed", status: "failed" });
    // verify 4: a startup that fails after binding must retain BOTH identities,
    // or bounded cleanup has nothing to target the run on its own server with.
    expect(manifest.tmuxSocket).toBe("/tmp/ls-a/a.sock");
    expect(manifest.tmuxSession).toBe("repo-loop-1");
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test("runInTmux never kills a winner when paired new-session loses a duplicate-session race", async () => {
  const calls: string[][] = [];
  let closed = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
  });
  let stoppedProxy = 0;
  let stoppedProxyRequest:
    | { caller: string; requesterPid?: number }
    | undefined;
  let winnerSessionLive = false;
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        getCodexAppServerPid: () => 45_000,
        getCodexAppServerUrl: () => "ws://127.0.0.1:4500",
        getLastCodexThreadId: () => "codex-thread-loser",
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: (nextOpts) => {
          nextOpts.codexMcpConfigArgs = [
            "-c",
            'mcp_servers.loop-bridge.command="loop"',
          ];
          return { manifest, storage };
        },
        startCodexProxy: () => Promise.resolve("ws://127.0.0.1:4600/"),
        startPersistentAgentSession: () => Promise.resolve(undefined),
        stopCodexProxy: (_proxyUrl, request) => {
          stoppedProxy += 1;
          stoppedProxyRequest = request;
          return Promise.resolve();
        },
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            return winnerSessionLive
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            winnerSessionLive = true;
            return {
              exitCode: 1,
              stderr: "duplicate session: repo-loop-1",
            };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "kill-session") {
            winnerSessionLive = false;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions(),
        task: "Ship feature",
      }
    )
  ).rejects.toThrow(
    "Failed to start tmux session: duplicate session: repo-loop-1"
  );

  expect(winnerSessionLive).toBe(true);
  expect(stoppedProxyRequest).toEqual({
    caller: "paired-start-cleanup",
    requesterPid: process.pid,
  });
  expect(
    calls.filter(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "has-session"
    )
  ).toHaveLength(2);
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(closed).toBe(1);
  expect(stoppedProxy).toBe(1);
  expect(manifest).toMatchObject({
    codexAppServerPid: undefined,
    codexRemoteUrl: undefined,
    codexThreadId: "",
    state: "submitted",
    status: "running",
  });
});

test("runInTmux cleans an owned paired session when setup fails after new-session", async () => {
  const calls: string[][] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  let sessionLive = false;
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return sessionLive
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
            sessionLive = true;
            return { exitCode: 0, stderr: "", stdout: "%91" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "split-window") {
            return { exitCode: 1, stderr: "split boom" };
          }
          if (args[0] === "tmux" && args.includes("kill-session")) {
            sessionLive = false;
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Ship feature",
      }
    )
  ).rejects.toThrow("Failed to split tmux window: split boom");

  expect(sessionLive).toBe(false);
  expect(
    calls.filter((args) => args[0] === "tmux" && args.includes("kill-session"))
  ).toEqual([
    ["tmux", "-S", "/tmp/ls-a/a.sock", "kill-session", "-t", "repo-loop-1"],
  ]);
  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test("runInTmux terminalizes the paired manifest when the workspace disappears before attach", async () => {
  const calls: string[][] = [];
  const updatedPaths: string[] = [];
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "submitted",
    status: "running",
    tmuxSocket: "/tmp/ls-a/a.sock",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: makeTempRunDir(),
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux", "--proof", "verify with tests"],
      {
        capturePane: () => "",
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        launchArgv: ["bun", "/repo/src/cli.ts"],
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        sendKeys: (): void => undefined,
        sendText: (): void => undefined,
        sleep: () => Promise.resolve(),
        spawn: (args: string[]) => {
          calls.push(args);
          if (args[0] === "tmux" && args.includes("has-session")) {
            return { exitCode: 1, stderr: "session not found" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (path, update) => {
          updatedPaths.push(path);
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Ship feature",
      }
    )
  ).rejects.toThrow('tmux session "repo-loop-1" exited before attach.');

  expect(updatedPaths.length).toBeGreaterThan(0);
  expect(new Set(updatedPaths)).toEqual(new Set([storage.manifestPath]));
  expect(
    calls.some(
      (args) => args[0] === "tmux" && tmuxCommand(args) === "kill-session"
    )
  ).toBe(false);
  expect(manifest).toMatchObject({
    state: "failed",
    status: "failed",
    tmuxSession: "repo-loop-1",
  });
});

test("runInTmux preserves external transport ownership when a resumed workspace disappears", async () => {
  let closed = 0;
  let sessionProbes = 0;
  let manifest = createRunManifest({
    codexAppServerPid: 45_000,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "codex-thread-1",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        closePersistentCodexSession: () => {
          closed += 1;
          return Promise.resolve();
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            sessionProbes += 1;
            return sessionProbes === 1
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      { opts: makePairedOptions(), task: "Resume feature" }
    )
  ).rejects.toThrow('tmux session "repo-loop-1" exited before attach.');

  expect(closed).toBe(0);
  expect(manifest).toMatchObject({
    codexAppServerPid: 45_000,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    state: "failed",
    status: "failed",
  });
});

test("runInTmux terminalizes a paired manifest when attach confirms the workspace is gone", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      attach: () => {
        throw new Error("no server running");
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => true,
      log: (): void => undefined,
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: () => ({ manifest, storage }),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          sessionProbes += 1;
          return sessionProbes <= 2
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    {
      opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
      task: "Resume feature",
    }
  );

  expect(delegated).toBe(false);
  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test("runInTmux preserves the active manifest when attach-path liveness is unknown", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        attach: () => {
          throw new Error("attach failed");
        },
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => true,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            sessionProbes += 1;
            return sessionProbes <= 2
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "permission denied" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Resume feature",
      }
    )
  ).rejects.toThrow(
    'tmux session "repo-loop-1" liveness is unknown; refusing handoff or terminalization: permission denied'
  );

  expect(manifest).toMatchObject({ state: "working", status: "running" });
});

test("runInTmux treats an attach capability error as non-fatal when the exact paired session remains live", async () => {
  const attaches: Array<{ session: string; socket?: string }> = [];
  const calls: string[][] = [];
  const logs: string[] = [];
  const postStartProbes: string[][] = [];
  let released = 0;
  let sessionCreated = false;
  const runDir = makeTempRunDir();
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
    tmuxSocket: "/tmp/ai-cur-tmux/tmux-501/default",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir,
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      attach: (session, socket) => {
        attaches.push({ session, socket });
        throw new Error(
          "open terminal failed: terminal does not support clear"
        );
      },
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => true,
      log: (line): void => {
        logs.push(line);
      },
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: () => ({ manifest, storage }),
      releasePersistentCodexSession: () => {
        released += 1;
      },
      spawn: (args: string[]) => {
        calls.push(args);
        if (args[0] === "tmux" && tmuxCommand(args) === "new-session") {
          sessionCreated = true;
          return { exitCode: 0, stderr: "", stdout: "%91" };
        }
        if (args.includes("has-session")) {
          if (sessionCreated) {
            postStartProbes.push(args);
          }
          return sessionCreated
            ? { exitCode: 0, stderr: "" }
            : { exitCode: 1, stderr: "session not found" };
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    {
      opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
      task: "Resume feature",
    }
  );

  expect(delegated).toBe(true);
  expect(sessionCreated).toBe(true);
  expect(postStartProbes.length).toBeGreaterThan(0);
  expect(postStartProbes).toEqual(
    postStartProbes.map(() => [
      "tmux",
      "-S",
      "/tmp/ai-cur-tmux/tmux-501/default",
      "has-session",
      "-t",
      "repo-loop-1",
    ])
  );
  expect(attaches).toEqual([
    {
      session: "repo-loop-1",
      socket: "/tmp/ai-cur-tmux/tmux-501/default",
    },
  ]);
  expect(logs).toContain(
    "[loop] warning: foreground tmux attach failed (open terminal failed: terminal does not support clear); detached session \"repo-loop-1\" remains live. Attach manually with: tmux -S '/tmp/ai-cur-tmux/tmux-501/default' attach -t 'repo-loop-1'"
  );
  expect(released).toBe(1);
  expect(manifest).toMatchObject({ state: "working", status: "running" });
  rmSync(runDir, { force: true, recursive: true });
});

test("runInTmux rejects a failed pre-handoff window setup and terminalizes the manifest", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            sessionProbes += 1;
            return sessionProbes <= 2
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          if (args[0] === "tmux" && tmuxCommand(args) === "set-window-option") {
            return { exitCode: 1, stderr: "no such session" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Resume feature",
      }
    )
  ).rejects.toThrow('tmux session "repo-loop-1" exited before attach.');

  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test("runInTmux treats optional remain-on-exit timeout as best-effort and preserves the live manifest", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  const delegated = await runInTmux(
    ["--tmux"],
    {
      cwd: "/repo",
      env: {},
      findBinary: () => true,
      isInteractive: () => false,
      log: (): void => undefined,
      ...healthyClaudeKickoffDeps(),
      preparePairedRun: () => ({ manifest, storage }),
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
          sessionProbes += 1;
          return { exitCode: 0, stderr: "" };
        }
        if (args[0] === "tmux" && tmuxCommand(args) === "set-window-option") {
          return {
            exitCode: 124,
            stderr: "tmux control command timed out after 2000ms",
            timedOut: true,
          };
        }
        return { exitCode: 0, stderr: "" };
      },
      updateRunManifest: (_path, update) => {
        manifest = update(manifest) ?? manifest;
        return manifest;
      },
    },
    {
      opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
      task: "Resume feature",
    }
  );

  expect(delegated).toBe(true);
  expect(sessionProbes).toBe(3);
  expect(manifest).toMatchObject({ state: "working", status: "running" });
});

test("runInTmux rejects a noninteractive handoff race and terminalizes the active manifest", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "working",
    status: "running",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            sessionProbes += 1;
            return sessionProbes <= 2
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Resume feature",
      }
    )
  ).rejects.toThrow('tmux session "repo-loop-1" exited before handoff.');

  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test("runInTmux does not report a successful handoff for an already-failed manifest", async () => {
  let sessionProbes = 0;
  let manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-123",
    runId: "1",
    state: "failed",
    status: "failed",
    tmuxSession: "repo-loop-1",
  });
  const storage = {
    manifestPath: "/isolated/home/.loop/runs/repo-123/1/manifest.json",
    repoId: "repo-123",
    runDir: "/isolated/home/.loop/runs/repo-123/1",
    runId: "1",
    storageRoot: "/isolated/home/.loop/runs/repo-123",
    transcriptPath: "/isolated/home/.loop/runs/repo-123/1/transcript.jsonl",
  };

  await expect(
    runInTmux(
      ["--tmux"],
      {
        cwd: "/repo",
        env: {},
        findBinary: () => true,
        isInteractive: () => false,
        log: (): void => undefined,
        ...healthyClaudeKickoffDeps(),
        preparePairedRun: () => ({ manifest, storage }),
        spawn: (args: string[]) => {
          if (args[0] === "tmux" && tmuxCommand(args) === "has-session") {
            sessionProbes += 1;
            return sessionProbes <= 2
              ? { exitCode: 0, stderr: "" }
              : { exitCode: 1, stderr: "session not found" };
          }
          return { exitCode: 0, stderr: "" };
        },
        updateRunManifest: (_path, update) => {
          manifest = update(manifest) ?? manifest;
          return manifest;
        },
      },
      {
        opts: makePairedOptions({ agent: "gemini", pairWith: "cursor" }),
        task: "Resume feature",
      }
    )
  ).rejects.toThrow('tmux session "repo-loop-1" exited before handoff.');

  expect(manifest).toMatchObject({ state: "failed", status: "failed" });
});

test("runInTmux skips auto-attach for non-interactive sessions", async () => {
  const attaches: string[] = [];

  const delegated = await runInTmux(["--tmux", "--proof", "verify"], {
    attach: (session: string) => {
      attaches.push(session);
    },
    cwd: "/repo",
    env: {},
    findBinary: () => true,
    isInteractive: () => false,
    spawn: () => ({ exitCode: 0, stderr: "" }),
  });

  expect(delegated).toBe(true);
  expect(attaches).toEqual([]);
});

test("persistent Codex bootstrap failure falls back to tmux delivery", async () => {
  const logs: string[] = [];
  let closed = 0;
  const opts = makePairedOptions();
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-1",
    runId: "1",
  });

  const result = await tmuxInternals.preparePersistentTmuxLaunch(
    {
      closePersistentCodexSession: () => {
        closed += 1;
        return Promise.resolve();
      },
      env: {},
      getCodexAppServerPid: () => undefined,
      getCodexAppServerUrl: () => "",
      getLastCodexThreadId: () => "",
      log: (line: string) => logs.push(line),
      makeClaudeSessionId: () => "claude-session-1",
      startPersistentAgentSession: () =>
        Promise.reject(new Error("transport unavailable")),
    } as never,
    opts,
    manifest,
    "utility-first"
  );

  expect(result).toEqual({
    claudeSessionId: "claude-session-1",
    codexRemoteUrl: "",
    codexThreadId: "",
  });
  expect(closed).toBe(1);
  expect(logs).toEqual([
    "[loop] transport unavailable; starting Codex with tmux bridge delivery instead.",
  ]);
});

test("runInTmux reports when tmux session exits before attach", async () => {
  const runBase = currentRunBase(process.cwd(), "1");
  await expect(
    runInTmux(["--tmux", "--proof", "verify"], {
      env: {},
      findBinary: () => true,
      spawn: (args: string[]) => {
        if (args[0] === "tmux" && args.includes("has-session")) {
          return { exitCode: 1, stderr: "session not found" };
        }
        return { exitCode: 0, stderr: "" };
      },
    })
  ).rejects.toThrow(
    `tmux session "${tmuxInternals.buildRunName(runBase, 1)}" exited before attach.`
  );
});

test("tmux internals strip --tmux from forwarded args", () => {
  expect(tmuxInternals.stripTmuxFlag(["--tmux", "--proof", "verify"])).toEqual([
    "--proof",
    "verify",
  ]);
});

test("tmux internals build launch argv from exec path", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      ["/usr/local/bin/bun", "src/cli.ts", "--tmux", "--proof", "verify"],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/bun", `${process.cwd()}/src/cli.ts`]);
});

test("tmux internals build launch argv for bun-compiled binary", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/usr/local/bin/bun",
        "/$bunfs/root/loop",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/private/tmp/loop"
    )
  ).toEqual(["/private/tmp/loop"]);
});

test("tmux internals build launch argv for executable with no script arg", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      ["/usr/local/bin/loop", "--tmux", "--proof", "verify"],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/loop"]);
});

test("tmux internals build launch argv for installed executable", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/Users/lume/.local/bin/loop",
        "build launch command",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/Users/lume/.local/bin/loop"
    )
  ).toEqual(["/Users/lume/.local/bin/loop"]);
});

test("tmux internals build launch argv when bun executes installed binary", () => {
  expect(
    tmuxInternals.buildLaunchArgv(
      [
        "/usr/local/bin/bun",
        "/Users/lume/.local/bin/loop",
        "--tmux",
        "--proof",
        "verify",
      ],
      "/usr/local/bin/bun"
    )
  ).toEqual(["/usr/local/bin/bun", "/Users/lume/.local/bin/loop"]);
});

test("tmux internals quote single quotes safely", () => {
  expect(tmuxInternals.quoteShellArg("a'b")).toBe("'a'\\''b'");
});

test("tmux internals build shell command with escaping", () => {
  expect(tmuxInternals.buildShellCommand(["loop", "--prompt", "a'b c"])).toBe(
    "'loop' '--prompt' 'a'\\''b c'"
  );
});

test("tmux internals unref detached helper processes", () => {
  const calls: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
  let unrefCount = 0;

  tmuxInternals.spawnDetachedProcess(
    ["loop", "__codex-tmux-proxy"],
    { HOME: "/tmp/home" },
    (argv, options) => {
      calls.push({
        argv: argv.map((value) => String(value)),
        options: options as Record<string, unknown>,
      });
      return {
        unref: () => {
          unrefCount += 1;
        },
      } as ReturnType<typeof import("bun").spawn>;
    }
  );

  expect(calls).toEqual([
    {
      argv: ["loop", "__codex-tmux-proxy"],
      options: {
        detached: process.platform !== "win32",
        env: { HOME: "/tmp/home" },
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      },
    },
  ]);
  expect(unrefCount).toBe(1);
});

test("tmux internals launch Claude in bypass mode", () => {
  expect(
    tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      "loop-bridge-1",
      false
    )
  ).toContain("--dangerously-skip-permissions");
  expect(
    tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      "loop-bridge-1",
      false
    )
  ).not.toContain("--permission-mode");
  expect(
    tmuxInternals.buildClaudeCommand(
      "claude-session-1",
      "opus",
      "loop-bridge-1",
      false,
      undefined,
      undefined,
      "/run/claude-mcp.json"
    )
  ).toEqual(
    expect.arrayContaining([
      "--mcp-config",
      "/run/claude-mcp.json",
      "--strict-mcp-config",
    ])
  );
});

test("tmux internals build run names", () => {
  expect(tmuxInternals.buildRunName("repo", 3)).toBe("repo-loop-3");
});

test("tmux internals detect session conflicts", () => {
  expect(tmuxInternals.isSessionConflict("duplicate session: loop-1")).toBe(
    true
  );
  expect(tmuxInternals.isSessionConflict("already exists")).toBe(true);
  expect(tmuxInternals.isSessionConflict("boom")).toBe(false);
});

test("tmux internals sanitize run base names", () => {
  expect(tmuxInternals.sanitizeBase("My Repo")).toBe("my-repo");
});

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "../../src/loop/args";
import {
  advanceHandoverControl,
  defaultGovernessDeps,
  driveHandoverControl,
  freshRunState,
  type GovernessConfig,
  renderExitControl,
  stopGovernessLoop,
} from "../../src/loop/governess";
import {
  agentCommandIsRunning,
  agentHasExited,
  exitKeyAction,
  HANDOVER_CONTINUATION_PROMPT,
  handoverContinuationFile,
  handoverContinuationText,
  openRawKeyInput,
  paneProbeFromTmuxResult,
  readExitControl,
  replacementLoopArgs,
} from "../../src/loop/governess-exit";
import {
  acceptGovernessHandoff,
  handoffLineageForReplacement,
  readGovernessHandoffManifest,
} from "../../src/loop/governess-handoff";
import {
  cleanupRunOwnedProcesses,
  registerRunOwnedProcess,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";
import { tmuxInternals } from "../../src/loop/tmux";
import { TmuxControlUnavailableError } from "../../src/loop/tmux-control";

test("x opens a reversible menu and only explicit e or h selects an exit", () => {
  expect(exitKeyAction(false, "idle", "x")).toBe("menu");
  expect(exitKeyAction(false, "idle", "e")).toBeUndefined();
  expect(exitKeyAction(true, "idle", "e")).toBe("teardown");
  expect(exitKeyAction(true, "idle", "h")).toBe("handover");
  expect(exitKeyAction(true, "idle", "x")).toBe("cancel");
  expect(exitKeyAction(true, "idle", "c")).toBe("cancel");
  expect(exitKeyAction(true, "idle", "\u001b")).toBe("cancel");
});

test("handover accepts only force teardown and launch retry keys", () => {
  expect(exitKeyAction(false, "handover", "e")).toBe("teardown");
  expect(exitKeyAction(false, "handover", "h")).toBeUndefined();
  expect(exitKeyAction(false, "launch-error", "h")).toBe("handover");
  expect(exitKeyAction(false, "launch-error", "e")).toBe("teardown");
});

test("persisted exit state is validated", () => {
  expect(
    readExitControl({
      exitRequested: {},
      handoverEpoch: 41,
      mode: "handover",
      notified: {},
      requestedAt: "2026-08-05T02:38:25.017Z",
    })
  ).toEqual({
    handoverEpoch: 41,
    mode: "handover",
    notified: {},
    requestedAt: "2026-08-05T02:38:25.017Z",
  });
  expect(
    readExitControl({
      exitRequested: { codex: true, unknown: true },
      launchError: "boom",
      mode: "launch-error",
      notified: { claude: true, codex: false, unknown: true },
      requestedAt: "2026-07-25T00:00:00.000Z",
    })
  ).toEqual({
    exitRequested: { codex: true },
    launchError: "boom",
    mode: "launch-error",
    notified: { claude: true },
    requestedAt: "2026-07-25T00:00:00.000Z",
  });
  expect(readExitControl({ mode: "invalid", notified: [] })).toEqual({
    mode: "idle",
    notified: {},
  });
  expect(
    readExitControl({ handoverEpoch: -1, mode: "handover", notified: {} })
  ).toEqual({ mode: "handover", notified: {} });
  expect(readExitControl({ mode: "launched", notified: {} })).toEqual({
    launchError: "replacement session was not persisted",
    mode: "launch-error",
    notified: {},
  });
});

test("agent exit detection distinguishes the TUI from a dead pane or shell", () => {
  expect(agentCommandIsRunning("claude", "0:claude")).toBe(true);
  expect(agentCommandIsRunning("codex", "0:codex")).toBe(true);
  expect(agentCommandIsRunning("codex", "1:codex")).toBe(false);
  expect(agentCommandIsRunning("codex", "0:zsh")).toBe(false);
  expect(agentHasExited("codex", "1:codex")).toBe(true);
  expect(agentHasExited("codex", "0:zsh")).toBe(true);
  expect(agentHasExited("codex", "0:codex-aarch64-a")).toBe(false);
  expect(agentHasExited("codex", "0:node")).toBe(false);
  expect(agentHasExited("codex", "")).toBe(false);
  expect(agentHasExited("codex", undefined)).toBe(false);
  expect(agentHasExited("codex", "malformed")).toBe(false);
});

test("tmux pane probes preserve confirmed missing targets but not empty successful output", () => {
  expect(paneProbeFromTmuxResult(0, "0:codex-aarch64-a\n")).toBe(
    "0:codex-aarch64-a"
  );
  expect(paneProbeFromTmuxResult(0, "0:zsh\n")).toBe("0:zsh");
  expect(paneProbeFromTmuxResult(1, "")).toBe("1:missing");
  expect(paneProbeFromTmuxResult(1, "unexpected output")).toBe("1:missing");
  expect(paneProbeFromTmuxResult(0, "\n")).toBeUndefined();
  expect(agentHasExited("codex", paneProbeFromTmuxResult(1, ""))).toBe(true);
});

test("replacement args preserve pairing and supply a continuation prompt", () => {
  const args = replacementLoopArgs("claude", "codex");
  expect(args).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--prompt",
    HANDOVER_CONTINUATION_PROMPT,
  ]);
});

test("replacement handover uses a markdown continuation file to skip replanning", () => {
  const dir = "/tmp/handoff/42";
  expect(handoverContinuationFile(dir)).toBe("/tmp/handoff/42/continuation.md");
  expect(handoverContinuationText(dir)).toContain(
    "Read every validated handover bundle in /tmp/handoff/42 before acting."
  );
  expect(replacementLoopArgs("claude", "codex", dir)).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--prompt",
    "/tmp/handoff/42/continuation.md",
  ]);
});

test("replacement handover carries exact frozen role efforts", () => {
  expect(
    replacementLoopArgs("claude", "codex", "/tmp/handoff/42", {
      driverEffort: "high",
      reviewerEffort: "low",
    })
  ).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--effort-driver",
    "high",
    "--effort-reviewer",
    "low",
    "--prompt",
    "/tmp/handoff/42/continuation.md",
  ]);
});

test("D7 governed handoff preserves exact effective launch identity", () => {
  const sourceIdentity = {
    runId: "191",
    repoId: "agents-collab-harvto-supervisor-defects",
    workspace: {
      root: "/tmp/d7-workspace",
      repoId: "agents-collab-harvto-supervisor-defects",
      branchRef: "refs/heads/d7-handoff-identity",
    },
    primary: "codex" as const,
    peer: "claude" as const,
    models: {
      codex: "gpt-5.6-sol",
      claude: "opus",
    },
    efforts: {
      driverEffort: "high" as const,
      reviewerEffort: "low" as const,
    },
  };
  const ambientNames = [
    "LOOP_CODEX_MODEL",
    "LOOP_EFFORT",
    "LOOP_DRIVER_EFFORT",
    "LOOP_REVIEWER_EFFORT",
  ] as const;
  const ambientBefore = Object.fromEntries(
    ambientNames.map((name) => [name, process.env[name]])
  );
  let observation:
    | {
        sourceIdentity: typeof sourceIdentity;
        hostileAmbient: Record<string, string | undefined>;
        replacementArgv: string[];
        parsedOptions: Record<string, unknown>;
        launchArgv: string[];
        resolvedEffectiveModel: string | undefined;
      }
    | undefined;

  try {
    process.env.LOOP_CODEX_MODEL = "gpt-5.6-luna";
    process.env.LOOP_EFFORT = "low";
    Reflect.deleteProperty(process.env, "LOOP_DRIVER_EFFORT");
    Reflect.deleteProperty(process.env, "LOOP_REVIEWER_EFFORT");

    const replacementArgv = replacementLoopArgs(
      sourceIdentity.primary,
      sourceIdentity.peer,
      "/tmp/d7-handoff",
      sourceIdentity.efforts,
      {
        primaryModel: sourceIdentity.models.codex,
        reviewerModel: sourceIdentity.models.claude,
      }
    );
    const parsedOptions = parseArgs(replacementArgv);
    parsedOptions.codexMcpConfigArgs = [
      "-c",
      'mcp_servers.loop-bridge.command="loop"',
    ];
    const launchArgv = tmuxInternals.buildPairedAgentCommand({
      agent: "codex",
      claudeChannelServer: "loop-bridge-d7",
      claudeSessionId: "d7-claude-session",
      codexProxyUrl: "ws://127.0.0.1:4600/",
      hadSession: false,
      nativeSubagentMode: "off",
      opts: parsedOptions,
    });
    const modelIndex = launchArgv.indexOf("-m");
    observation = {
      sourceIdentity,
      hostileAmbient: Object.fromEntries(
        ambientNames.map((name) => [name, process.env[name]])
      ),
      replacementArgv,
      parsedOptions: {
        agent: parsedOptions.agent,
        pairWith: parsedOptions.pairWith,
        codexModel: parsedOptions.codexModel,
        driverEffort: parsedOptions.driverEffort,
        reviewerEffort: parsedOptions.reviewerEffort,
        promptInput: parsedOptions.promptInput,
        codexMcpConfigArgs: parsedOptions.codexMcpConfigArgs,
      },
      launchArgv,
      resolvedEffectiveModel:
        modelIndex === -1 ? undefined : launchArgv[modelIndex + 1],
    };
  } finally {
    for (const name of ambientNames) {
      const value = ambientBefore[name];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }

  expect(
    Object.fromEntries(ambientNames.map((name) => [name, process.env[name]]))
  ).toEqual(ambientBefore);
  expect(observation).toBeDefined();
  if (observation?.resolvedEffectiveModel !== sourceIdentity.models.codex) {
    throw new Error(
      `D7 hostile-default model drift: expected ${sourceIdentity.models.codex}, received ${observation?.resolvedEffectiveModel}\n${JSON.stringify(observation, null, 2)}`
    );
  }
});

test("D7 replacement argv maps frozen primary and reviewer models by role", () => {
  const cases = [
    {
      expected: [
        "--codex-model",
        "codex-primary",
        "--claude-reviewer-model",
        "claude-peer",
      ],
      peer: "claude" as const,
      primary: "codex" as const,
      primaryModel: "codex-primary",
      reviewerModel: "claude-peer",
    },
    {
      expected: [
        "--gemini-model",
        "gemini-primary",
        "--copilot-reviewer-model",
        "copilot-peer",
      ],
      peer: "copilot" as const,
      primary: "gemini" as const,
      primaryModel: "gemini-primary",
      reviewerModel: "copilot-peer",
    },
    {
      expected: [
        "--cursor-model",
        "cursor-primary",
        "--codex-reviewer-model",
        "codex-peer",
      ],
      peer: "codex" as const,
      primary: "cursor" as const,
      primaryModel: "cursor-primary",
      reviewerModel: "codex-peer",
    },
    {
      expected: ["--gemini-reviewer-model", "gemini-peer"],
      peer: "gemini" as const,
      primary: "claude" as const,
      primaryModel: "opus",
      reviewerModel: "gemini-peer",
    },
  ];
  for (const fixture of cases) {
    const argv = replacementLoopArgs(
      fixture.primary,
      fixture.peer,
      "/tmp/d7-handoff",
      { driverEffort: "high", reviewerEffort: "low" },
      {
        primaryModel: fixture.primaryModel,
        reviewerModel: fixture.reviewerModel,
      }
    );
    const promptIndex = argv.indexOf("--prompt");
    expect(
      argv.slice(promptIndex - fixture.expected.length, promptIndex)
    ).toEqual(fixture.expected);
  }

  expect(() =>
    replacementLoopArgs(
      "claude",
      "codex",
      "/tmp/d7-handoff",
      { driverEffort: "high", reviewerEffort: "low" },
      { primaryModel: "future-claude", reviewerModel: "codex-peer" }
    )
  ).toThrow("cannot preserve Claude primary model future-claude");
});

test("exit controls replace the status row without growing the board", () => {
  const board = "status\nrow 2\nrow 3";
  const agents = [
    { agent: "claude" as const, hookFile: "", pane: "session:0.0" },
    { agent: "codex" as const, hookFile: "", pane: "session:0.1" },
  ];
  const menu = renderExitControl(
    board,
    readExitControl(undefined),
    true,
    agents,
    () => ""
  );
  expect(menu.split("\n")).toHaveLength(3);
  expect(menu.split("\n")[0]).toContain("[e] tear down loop");
  expect(menu.split("\n")[0]).toContain("[h] hand over to new loop");

  const progress = renderExitControl(
    board,
    readExitControl({ mode: "handover", notified: { claude: true } }),
    false,
    agents,
    (pane) => (pane.endsWith(".0") ? "0:claude" : "0:codex"),
    { claude: "/handoff/claude.json" }
  );
  expect(progress.split("\n")[0]).toContain("claude:exiting");
  expect(progress.split("\n")[0]).toContain("codex:finishing");
});

const handoverConfig = (): GovernessConfig => {
  const runDir = mkdtempSync(join(tmpdir(), "governess-exit-test-"));
  return {
    agents: [
      { agent: "claude", hookFile: "claude", pane: "session:0.0" },
      { agent: "codex", hookFile: "codex", pane: "session:0.1" },
    ],
    cwd: runDir,
    driverEffort: "medium",
    initialDriver: "claude",
    epoch: 1,
    logFile: "/tmp/governess-test.jsonl",
    manifestPath: join(runDir, "manifest.json"),
    runDir,
    runId: "source-run",
    reviewerEffort: "high",
    session: "session",
  } as GovernessConfig;
};

const writeSourceLaunchManifest = (config: GovernessConfig): void => {
  const primary = config.initialDriver ?? config.agents[0]?.agent;
  const peer = config.agents.find((info) => info.agent !== primary)?.agent;
  if (!(primary && peer && config.cwd && config.manifestPath)) {
    throw new Error("invalid handover source fixture");
  }
  const repoId = "d7-fixture-repo";
  const workspaceBinding = { repoId, root: config.cwd };
  const modelFor = (agent: string): string => {
    if (agent === "claude") {
      return "opus";
    }
    if (agent === "codex") {
      return "gpt-5.6-sol";
    }
    return `${agent}-model`;
  };
  const launchIdentity = {
    cwd: config.cwd,
    peer: {
      agent: peer,
      effort: config.reviewerEffort,
      model: modelFor(peer),
      role: "reviewer" as const,
    },
    primary: {
      agent: primary,
      effort: config.driverEffort,
      model: modelFor(primary),
      role: "driver" as const,
    },
    repoId,
    runId: config.runId,
    workspaceBinding,
  };
  writeRunManifest(
    config.manifestPath,
    createRunManifest({
      cwd: config.cwd,
      driverEffort: config.driverEffort,
      launchIdentity,
      mode: "paired",
      pid: 1234,
      primaryAgent: primary,
      repoId,
      reviewerEffort: config.reviewerEffort,
      runId: config.runId,
      state: "working",
      tmuxPaneLeftAgent: config.agents[0]?.agent,
      tmuxPaneRightAgent: config.agents[1]?.agent,
      tmuxSession: config.session,
      workspaceBinding,
    })
  );
};

const writeHandoverBundles = (
  config: GovernessConfig,
  state: ReturnType<typeof freshRunState>,
  agents: Array<"claude" | "codex"> = ["claude", "codex"]
): void => {
  writeSourceLaunchManifest(config);
  const dir = join(
    config.runDir as string,
    "handoff",
    String(state.governessEpoch)
  );
  mkdirSync(dir, { recursive: true });
  for (const agent of agents) {
    writeFileSync(
      join(dir, `${agent}.json`),
      JSON.stringify({
        agent,
        blockers: [],
        checks: ["focused tests"],
        dirtyFiles: [],
        epoch: state.governessEpoch,
        gitHead: "abc123",
        next: "continue",
        status: "ready",
        summary: "atomic step complete",
      })
    );
  }
};

const acceptReplacement = (
  state: ReturnType<typeof freshRunState>,
  session = "replacement"
): void => {
  const manifest = state.exitControl.handoverManifest;
  if (!manifest) {
    throw new Error("handover manifest was not persisted");
  }
  const handoff = readGovernessHandoffManifest(manifest);
  if (!handoff) {
    throw new Error("handover manifest was not readable");
  }
  const replacementIdentity = {
    ...handoff.sourceIdentity,
    runId: `${handoff.sourceIdentity.runId}-replacement`,
  };
  const lineage = handoffLineageForReplacement(handoff, replacementIdentity);
  if (!lineage) {
    throw new Error("replacement lineage did not match");
  }
  const replacementManifestPath = join(
    dirname(manifest),
    "replacement-manifest.json"
  );
  writeRunManifest(
    replacementManifestPath,
    createRunManifest({
      cwd: replacementIdentity.cwd,
      driverEffort: replacementIdentity.primary.effort,
      handoffLineage: lineage,
      launchIdentity: replacementIdentity,
      mode: "paired",
      pid: 4321,
      primaryAgent: replacementIdentity.primary.agent,
      repoId: replacementIdentity.repoId,
      reviewerEffort: replacementIdentity.peer.effort,
      runId: replacementIdentity.runId,
      state: "working",
      tmuxPaneLeftAgent: replacementIdentity.primary.agent,
      tmuxPaneRightAgent: replacementIdentity.peer.agent,
      tmuxSession: session,
      workspaceBinding: replacementIdentity.workspaceBinding,
    })
  );
  const accepted = acceptGovernessHandoff(
    manifest,
    session,
    state.governessEpoch + 1,
    "2026-07-25T00:00:01.000Z",
    replacementManifestPath
  );
  if (!accepted) {
    throw new Error("handover manifest was not accepted");
  }
};

test("handover waits for a busy agent, notifies each once, and launches after both exit", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: {},
    requestedAt: "2026-07-25T00:00:00.000Z",
  };
  const direct: string[] = [];
  const directOrder: string[] = [];
  const bridged: string[] = [];
  let launched = 0;
  let claudeTurnEnded = false;
  let saved = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) =>
      pane.endsWith(".0") ? "0:claude" : "0:codex",
    readHooks: (file: string) =>
      file === "codex" || claudeTurnEnded
        ? [{ agent: "claude" as const, event: "Stop", ts: "now" }]
        : [],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => {
      saved += 1;
    },
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
    sendKeys: (_pane: string, keys: string[]) =>
      directOrder.push(`keys:${keys.join(",")}`),
    sendText: (_pane: string, text: string) => {
      direct.push(text);
      directOrder.push("text");
    },
    sleep: (ms: number) => {
      directOrder.push(`sleep:${ms}`);
      return Promise.resolve();
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(saved).toBe(1);
  expect(bridged).toEqual(["codex"]);
  expect(direct).toHaveLength(0);
  expect(directOrder).toEqual([]);
  expect(launched).toBe(0);

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(direct).toHaveLength(0);

  claudeTurnEnded = true;
  deps.paneCommand = () => "0:zsh";
  writeHandoverBundles(config, state);
  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ claude: true, codex: true });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe("replacement");
  expect(direct).toHaveLength(0);
  expect(directOrder).toEqual([]);
  expect(bridged).toEqual(["codex", "claude"]);
  expect(launched).toBe(1);
  expect(saved).toBe(3);

  acceptReplacement(state);
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    session: "replacement",
    status: "launched",
  });
  expect(launched).toBe(1);
});

test("handover never injects over a notification or permission prompt", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: {},
  };
  const direct: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: (pane: string) =>
      pane.endsWith(".0") ? "0:claude" : "0:codex",
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "before-notification" },
      {
        agent: "claude" as const,
        detail: "Claude needs your permission",
        event: "Notification",
        ts: "now",
      },
    ],
    saveState: () => undefined,
    sendText: (_pane: string, text: string) => direct.push(text),
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({});
  expect(direct).toEqual([]);
});

test("handover treats a dim idle suggestion as an empty composer", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = { mode: "handover", notified: {} };
  const bridged: string[] = [];
  const styledCaptures: boolean[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: (_pane: string, styled = false) => {
      styledCaptures.push(styled);
      return styled
        ? "\u001b[39m› \u001b[2mWrite tests for @filename\u001b[0m\nfooter"
        : "› Write tests for @filename\nfooter";
    },
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:codex-aarch64-a",
    readHooks: () => [{ agent: "codex" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(styledCaptures).toEqual([true]);
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(bridged).toEqual(["codex"]);
});

test("handover accepts Claude Stop followed by trailing SubagentStop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    exitRequested: { codex: true },
    mode: "handover",
    notified: { codex: true },
  };
  const bridged: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m❯ \u001b[2mstart T2 now: run C5 then C2\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:claude",
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "now" },
      { agent: "claude" as const, event: "SubagentStop", ts: "now" },
    ],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "exited",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ claude: true, codex: true });
  expect(bridged).toEqual(["claude"]);
});

test("handover exits Claude after its exact generic idle notification", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    exitRequested: { codex: true },
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const exitKeys: [string, string[]][] = [];
  const exitText: [string, string][] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m❯ \u001b[2mstop here, waiting for the supervisor to launch loop-132\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: (pane: string) => (pane.endsWith(".0") ? "0:claude" : "0:zsh"),
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "parent-stopped" },
      {
        agent: "claude" as const,
        event: "SubagentStop",
        ts: "subagent-stopped",
      },
      {
        agent: "claude" as const,
        detail: "Claude is waiting for your input",
        event: "Notification",
        ts: "idle-notification",
      },
    ],
    saveState: () => undefined,
    sendKeys: (pane: string, keys: string[]) => exitKeys.push([pane, keys]),
    sendText: (pane: string, text: string) => exitText.push([pane, text]),
    sleep: async () => undefined,
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "exited",
    })
  ).toEqual({ status: "waiting" });
  expect(exitText).toEqual([["session:0.0", "/exit"]]);
  expect(exitKeys).toEqual([["session:0.0", ["Enter"]]]);
  expect(state.exitControl.exitRequested).toEqual({
    claude: true,
    codex: true,
  });
});

test("handover uses the durable bridge without typing over a composer draft", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = { mode: "handover", notified: {} };
  const bridged: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m› start T2 now: run C5 then C2\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:codex-aarch64-a",
    readHooks: () => [{ agent: "codex" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(bridged).toEqual(["codex"]);
});

test("handover revalidates the completed turn after pane capture", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = { mode: "handover", notified: {} };
  const bridged: string[] = [];
  let latestHook = { agent: "codex" as const, event: "Stop", ts: "stopped" };
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => {
      latestHook = {
        agent: "codex" as const,
        event: "Notification",
        ts: "permission-request",
      };
      return "\u001b[39m› \u001b[2mAsk for follow-up\u001b[0m\nfooter";
    },
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:codex-aarch64-a",
    readHooks: () => [latestHook],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({});
  expect(bridged).toEqual([]);
});

test("valid ready bundles close each drained TUI exactly once before launch", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const exitKeys: [string, string[]][] = [];
  const exitText: [string, string][] = [];
  let agentsExited = false;
  let launched = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) => {
      if (agentsExited) {
        return "0:zsh";
      }
      return pane.endsWith(".0") ? "0:claude" : "0:codex";
    },
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => undefined,
    sendKeys: (pane: string, keys: string[]) => exitKeys.push([pane, keys]),
    sendText: (pane: string, text: string) => exitText.push([pane, text]),
    sleep: async () => undefined,
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(exitKeys).toEqual([
    ["session:0.0", ["Enter"]],
    ["session:0.1", ["Enter"]],
  ]);
  expect(exitText).toEqual([
    ["session:0.0", "/exit"],
    ["session:0.1", "/exit"],
  ]);
  expect(state.exitControl.exitRequested).toEqual({
    claude: true,
    codex: true,
  });
  expect(launched).toBe(0);

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(exitKeys).toHaveLength(2);
  expect(exitText).toHaveLength(2);

  agentsExited = true;
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(launched).toBe(1);
  acceptReplacement(state);
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    session: "replacement",
    status: "launched",
  });
});

test("headless handover skips the missing pane and reaches owned teardown after acceptance", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const order: string[] = [];
  let claudeExited = false;
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      order.push(`log:${(record as { event: string }).event}`),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      return { killed: [321], skipped: [] };
    },
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      order.push("launch");
      return { ok: true, session: "replacement" };
    },
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    paneCommand: (pane: string) => {
      if (pane.endsWith(".1")) {
        return "1:missing";
      }
      return claudeExited ? "0:zsh" : "0:claude";
    },
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => order.push(`save:${state.exitControl.mode}`),
    sessionLiveness: () => "dead" as const,
    sendKeys: (pane: string, keys: string[]) =>
      order.push(`keys:${pane}:${keys.join(",")}`),
    sendText: (pane: string, text: string) =>
      order.push(`text:${pane}:${text}`),
    sleep: async () => undefined,
    tmuxIdentity: () => ({ session: config.session, socket: "fixture" }),
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(order.filter((item) => item.startsWith("text:"))).toEqual([
    "text:session:0.0:/exit",
  ]);
  expect(order.some((item) => item.includes("session:0.1"))).toBe(false);
  expect(launches).toBe(0);

  claudeExited = true;
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(launches).toBe(1);
  expect(state.exitControl.mode).toBe("launched");
  expect(order).not.toContain("mark");
  expect(order).not.toContain("cleanup");
  expect(order).not.toContain("kill");

  acceptReplacement(state);
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(true);
  expect(launches).toBe(1);
  expect(order).toEqual([
    "save:launched",
    "log:exit",
    "cleanup",
    "log:run-process-cleanup",
    "kill",
    "mark",
  ]);
});

test("unknown pane evidence keeps headless handover non-destructive", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const terminal: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: (pane: string) => {
      if (pane.endsWith(".1")) {
        throw new TmuxControlUnavailableError(["capture-pane", "-t", pane]);
      }
      return "";
    },
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) => (pane.endsWith(".1") ? undefined : "0:zsh"),
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendKeys: (pane: string) => terminal.push(`keys:${pane}`),
    sendText: (pane: string) => terminal.push(`text:${pane}`),
    sleep: async () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(launches).toBe(0);
  expect(terminal).toEqual([]);
  expect(state.exitControl.mode).toBe("handover");
});

test("replacement launch failure preserves the old loop for explicit retry or teardown", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => ({ error: "could not launch", ok: false }),
    now: () => 0,
    paneCommand: () => "0:zsh",
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    error: "could not launch",
    status: "launch-error",
  });
  expect(state.exitControl.mode).toBe("launch-error");
  expect(state.exitControl.launchError).toBe("could not launch");
});

test("handover persists launch success before marking and killing the old loop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const order: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      order.push(`log:${(record as { event: string }).event}`),
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      order.push("launch");
      return { ok: true, session: "replacement" };
    },
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => order.push(`save:${state.exitControl.mode}`),
    sessionLiveness: () => "dead" as const,
    tmuxIdentity: () => ({ session: config.session, socket: "fixture" }),
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(order).toEqual([
    "launch",
    "log:handover-launched",
    "save:launched",
    "save:launched",
  ]);
  expect(launches).toBe(1);

  acceptReplacement(state);
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(true);
  expect(launches).toBe(1);
  expect(order).toEqual(["save:launched", "log:exit", "kill", "mark"]);
});

test("handover launch failure never marks or kills the old loop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const destructive: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => ({ error: "failed", ok: false }),
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    saveState: () => undefined,
  };
  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(destructive).toEqual([]);
  expect(state.exitControl.mode).toBe("launch-error");
});

test("D7 governed handoff rejects legacy missing launch identity before spawn", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const source = readRunManifest(config.manifestPath as string);
  if (!source) {
    throw new Error("missing source fixture manifest");
  }
  writeRunManifest(config.manifestPath as string, {
    ...source,
    launchIdentity: undefined,
  });
  const destructive: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "replacement" } as const;
    },
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl).toMatchObject({
    launchError: "could not create validated handover manifest",
    mode: "launch-error",
  });
  expect(launches).toBe(0);
  expect(destructive).toEqual([]);
});

test("D7 replacement model mismatch cannot accept or tear down the old loop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const destructive: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "replacement" } as const;
    },
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => undefined,
  };
  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  const handoffPath = state.exitControl.handoverManifest as string;
  const handoff = readGovernessHandoffManifest(handoffPath);
  if (!handoff) {
    throw new Error("missing handoff fixture manifest");
  }
  const replacementIdentity = {
    ...handoff.sourceIdentity,
    primary: {
      ...handoff.sourceIdentity.primary,
      model: "gpt-5.6-luna",
    },
    runId: "replacement",
  };
  const replacementManifestPath = join(
    dirname(handoffPath),
    "mismatched-replacement.json"
  );
  writeRunManifest(
    replacementManifestPath,
    createRunManifest({
      cwd: replacementIdentity.cwd,
      driverEffort: replacementIdentity.primary.effort,
      launchIdentity: replacementIdentity,
      mode: "paired",
      pid: 4321,
      primaryAgent: replacementIdentity.primary.agent,
      repoId: replacementIdentity.repoId,
      reviewerEffort: replacementIdentity.peer.effort,
      runId: replacementIdentity.runId,
      state: "working",
      tmuxPaneLeftAgent: replacementIdentity.primary.agent,
      tmuxPaneRightAgent: replacementIdentity.peer.agent,
      tmuxSession: "replacement",
      workspaceBinding: replacementIdentity.workspaceBinding,
    })
  );
  expect(
    acceptGovernessHandoff(
      handoffPath,
      "replacement",
      state.governessEpoch + 1,
      "2026-07-25T00:00:01.000Z",
      replacementManifestPath
    )
  ).toBeUndefined();

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(launches).toBe(1);
  expect(destructive).toEqual([]);
  expect(state.exitControl.mode).toBe("launched");
});

test("handover restart keeps the persisted transaction epoch for replacement launch", async () => {
  const config = handoverConfig();
  // Keep this asymmetric and non-default: it must kill a launcher or manifest
  // mutation that silently hardcodes the driver effort back to medium.
  config.driverEffort = "high";
  config.reviewerEffort = "low";
  const state = freshRunState();
  state.governessEpoch = 41;
  writeHandoverBundles(config, state);
  const handoffDir = join(config.runDir as string, "handoff", "41");
  state.handoverBundles = {
    claude: join(handoffDir, "claude.json"),
    codex: join(handoffDir, "codex.json"),
  };
  state.exitControl = {
    exitRequested: { claude: true, codex: true },
    mode: "handover",
    notified: { claude: true, codex: true },
  };

  // A restarted Governess must acquire a fresh fencing epoch without
  // rebinding the already-complete handoff transaction to that epoch.
  state.governessEpoch = 99;
  config.epoch = 99;
  let launchedManifest: string | undefined;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: (_config: GovernessConfig, manifest: string) => {
      launchedManifest = manifest;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => undefined,
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.handoverEpoch).toBe(41);
  expect(launchedManifest).toBe(join(handoffDir, "manifest.json"));
  expect(readGovernessHandoffManifest(launchedManifest as string)?.epoch).toBe(
    41
  );
  expect(
    readGovernessHandoffManifest(launchedManifest as string)
  ).toMatchObject({
    driverEffort: "high",
    reviewerEffort: "low",
  });
});

test("restart preserves the old loop when the recorded replacement is dead", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "launched",
    notified: { claude: true, codex: true },
    replacementSession: "dead-replacement",
  };
  const destructive: string[] = [];
  let launched = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "another-replacement" };
    },
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    replacementSessionAlive: () => false,
    replacementSessionReady: () => false,
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl.mode).toBe("launch-error");
  expect(state.exitControl.launchError).toContain("is not running");
  expect(launched).toBe(0);
  expect(destructive).toEqual([]);
});

test("restart preserves a recorded replacement while tmux liveness is unknown", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    handoverManifest: "pending-acceptance.json",
    mode: "launched",
    notified: { claude: true, codex: true },
    replacementSession: "possibly-live-replacement",
  };
  const destructive: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    killSession: () => destructive.push("kill"),
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    replacementSessionAlive: () => "unknown" as const,
    replacementSessionReady: () => "unknown" as const,
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe(
    "possibly-live-replacement"
  );
  expect(state.exitControl.launchError).toBeUndefined();
  expect(destructive).toEqual([]);
});

test("an unconfirmed replacement probe is persisted without duplicate launch", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  let launches = 0;
  let replacementAlive: boolean | "unknown" = "unknown";
  let replacementReady: boolean | "unknown" = "unknown";
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "possibly-live-replacement" };
    },
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => replacementAlive,
    replacementSessionReady: () => replacementReady,
    saveState: () => undefined,
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe(
    "possibly-live-replacement"
  );
  expect(launches).toBe(1);

  replacementAlive = true;
  replacementReady = false;
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.launchError).toBeUndefined();
  expect(launches).toBe(1);
});

test("D15 tmux death is proved on the exact launch-recorded socket and session", () => {
  const config = handoverConfig();
  const order: string[] = [];
  const tmuxCalls: Array<{
    action: "kill" | "probe";
    session: string;
    socket: string;
  }> = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => order.push("log"),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      return { killed: [], skipped: [] };
    },
    fenceCurrent: () => true,
    killSession: (session: string, socket: string) => {
      tmuxCalls.push({ action: "kill", session, socket });
      order.push("kill");
    },
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    sessionLiveness: (session: string, socket: string) => {
      tmuxCalls.push({ action: "probe", session, socket });
      return "dead" as const;
    },
    tmuxIdentity: () => ({
      session: config.session,
      socket: "/private/tmp/d15-exact.sock",
    }),
  };
  stopGovernessLoop(config, deps, "user requested teardown");
  expect(order).toEqual(["log", "cleanup", "kill", "mark"]);
  expect(tmuxCalls).toEqual([
    {
      action: "kill",
      session: config.session,
      socket: "/private/tmp/d15-exact.sock",
    },
    {
      action: "probe",
      session: config.session,
      socket: "/private/tmp/d15-exact.sock",
    },
  ]);
});

test("D15 missing tmux socket fails without default-socket fallback", () => {
  const config = handoverConfig();
  const states: string[] = [];
  let unresolved: unknown;
  stopGovernessLoop(
    config,
    {
      ...defaultGovernessDeps(),
      appendLog: () => undefined,
      cleanupRunProcesses: () => ({ killed: [], skipped: [] }),
      fenceCurrent: () => true,
      killSession: () => {
        throw new Error("default socket fallback attempted");
      },
      markRunFailed: () => states.push("failed"),
      markRunStopped: () => states.push("stopped"),
      now: () => 0,
      recordCleanupUnresolved: (_config, issues) => {
        unresolved = issues;
      },
      sessionLiveness: () => {
        throw new Error("missing socket must not be probed");
      },
      tmuxIdentity: () => undefined,
    },
    "user requested teardown"
  );

  expect(states).toEqual(["failed"]);
  expect(unresolved).toEqual([{ pid: 0, reason: "tmux-identity-unavailable" }]);
});

test("D15 ordinary teardown transfers only its exact self launcher and reaches stopped", () => {
  const config = handoverConfig();
  const runDir = config.runDir as string;
  const original = { ...runProcessCleanupInternals.deps };
  const states = new Map<number, string>([
    [7801, "S"],
    [7802, "S"],
  ]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const lifecycle: string[] = [];
  const tmuxCalls: string[] = [];
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === 7801 ? "loop launcher" : "claude main agent";
    runProcessCleanupInternals.deps.currentPid = () => 7801;
    runProcessCleanupInternals.deps.now = () => "2026-08-15T12:00:00.000Z";
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = (pid) => states.get(pid);
    runProcessCleanupInternals.deps.signal = (pid, signal) => {
      signals.push({ pid, signal });
      states.set(pid, "Z");
    };
    const launcherPath = registerRunOwnedProcess(runDir, {
      pid: 7801,
      role: "launcher",
    });
    const agentPath = registerRunOwnedProcess(runDir, {
      agent: "claude",
      pid: 7802,
      role: "agent",
    });
    const manifest = createRunManifest({
      cwd: "/fixture/repo",
      mode: "paired",
      pid: 7801,
      repoId: "fixture-repo",
      runId: "15",
      tmuxSession: config.session,
      tmuxSocket: "/private/tmp/d15-exact.sock",
    });

    stopGovernessLoop(
      config,
      {
        ...defaultGovernessDeps(),
        appendLog: (_file, record) =>
          lifecycle.push((record as { event: string }).event),
        cleanupRunProcesses: () => cleanupRunOwnedProcesses(runDir, manifest),
        fenceCurrent: () => true,
        killSession: (session, socket) => {
          tmuxCalls.push(`kill:${session}:${socket}`);
        },
        markRunFailed: () => lifecycle.push("failed"),
        markRunStopped: () => lifecycle.push("stopped"),
        now: () => 0,
        recordCleanupUnresolved: () => {
          throw new Error("ordinary teardown must have no unresolved receipt");
        },
        sessionLiveness: (session, socket) => {
          tmuxCalls.push(`probe:${session}:${socket}`);
          return "dead";
        },
        tmuxIdentity: () => ({
          session: config.session,
          socket: "/private/tmp/d15-exact.sock",
        }),
      },
      "ordinary teardown"
    );

    const receiptPath = join(
      runDir,
      "run-processes",
      "deferred-launcher-7801.json"
    );
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      kind: "run-owned-deferred-launcher",
      pid: 7801,
      role: "launcher",
      schemaVersion: 1,
    });
    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(agentPath)).toBe(false);
    expect(
      existsSync(join(runDir, "run-processes", "unresolved-cleanup.json"))
    ).toBe(false);
    expect(signals).toEqual([{ pid: 7802, signal: "SIGTERM" }]);
    expect(tmuxCalls).toEqual([
      "kill:session:/private/tmp/d15-exact.sock",
      "probe:session:/private/tmp/d15-exact.sock",
    ]);
    expect(lifecycle).toContain("stopped");
    expect(lifecycle).not.toContain("failed");
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 production-shaped teardown settles launcher and agent before stopped", () => {
  const config = handoverConfig();
  const runDir = config.runDir as string;
  const original = { ...runProcessCleanupInternals.deps };
  const launcherPid = 7811;
  const agentPid = 7812;
  const states = new Map<number, string>([
    [launcherPid, "S"],
    [agentPid, "S"],
  ]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const lifecycle: string[] = [];
  try {
    runProcessCleanupInternals.deps.commandForPid = (pid) =>
      pid === launcherPid ? "loop launcher" : "claude main agent";
    runProcessCleanupInternals.deps.currentPid = () => 7899;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = (pid) => states.get(pid);
    runProcessCleanupInternals.deps.signal = (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === agentPid || signal === "SIGKILL") {
        states.set(pid, "Z");
      }
    };
    const launcherPath = registerRunOwnedProcess(runDir, {
      pid: launcherPid,
      role: "launcher",
    });
    const agentPath = registerRunOwnedProcess(runDir, {
      agent: "claude",
      pid: agentPid,
      role: "agent",
    });
    const manifest = createRunManifest({
      cwd: "/fixture/repo",
      mode: "paired",
      pid: launcherPid,
      repoId: "fixture-repo",
      runId: "15",
      tmuxSession: config.session,
      tmuxSocket: "/private/tmp/d15-production.sock",
    });

    stopGovernessLoop(
      config,
      {
        ...defaultGovernessDeps(),
        appendLog: () => undefined,
        cleanupRunProcesses: () => cleanupRunOwnedProcesses(runDir, manifest),
        fenceCurrent: () => true,
        killSession: () => undefined,
        markRunFailed: () => lifecycle.push("failed"),
        markRunStopped: () => lifecycle.push("stopped"),
        now: () => 0,
        recordCleanupUnresolved: () => {
          throw new Error(
            "settled production topology must have no unresolved receipt"
          );
        },
        sessionLiveness: () => "dead",
        tmuxIdentity: () => ({
          session: config.session,
          socket: "/private/tmp/d15-production.sock",
        }),
      },
      "ordinary teardown"
    );

    expect(signals.filter(({ pid }) => pid === launcherPid)).toEqual([
      { pid: launcherPid, signal: "SIGTERM" },
      { pid: launcherPid, signal: "SIGKILL" },
    ]);
    expect(signals.filter(({ pid }) => pid === agentPid)).toEqual([
      { pid: agentPid, signal: "SIGTERM" },
    ]);
    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(agentPath)).toBe(false);
    expect(
      existsSync(
        join(runDir, "run-processes", `deferred-launcher-${launcherPid}.json`)
      )
    ).toBe(false);
    expect(lifecycle).toEqual(["stopped"]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("D15 process surviving KILL keeps teardown failed with ownership evidence", () => {
  const config = handoverConfig();
  const runDir = config.runDir as string;
  const original = { ...runProcessCleanupInternals.deps };
  const pid = 7820;
  const signals: NodeJS.Signals[] = [];
  const lifecycle: string[] = [];
  let cleanupResult: ReturnType<typeof cleanupRunOwnedProcesses> | undefined;
  let recordedUnresolved: unknown;
  try {
    runProcessCleanupInternals.deps.commandForPid = () =>
      "claude surviving agent";
    runProcessCleanupInternals.deps.currentPid = () => 7899;
    runProcessCleanupInternals.deps.parentPidFor = () => 1;
    runProcessCleanupInternals.deps.pidAlive = () => true;
    runProcessCleanupInternals.deps.sleep = () => undefined;
    runProcessCleanupInternals.deps.startForPid = () =>
      "Sat Aug 15 12:00:00 2026";
    runProcessCleanupInternals.deps.stateForPid = () => "S";
    runProcessCleanupInternals.deps.signal = (_pid, signal) => {
      signals.push(signal);
    };
    const processPath = registerRunOwnedProcess(runDir, {
      agent: "claude",
      pid,
      role: "agent",
    });

    stopGovernessLoop(
      config,
      {
        ...defaultGovernessDeps(),
        appendLog: () => undefined,
        cleanupRunProcesses: () => {
          cleanupResult = cleanupRunOwnedProcesses(runDir, undefined);
          return cleanupResult;
        },
        fenceCurrent: () => true,
        killSession: () => undefined,
        markRunFailed: () => lifecycle.push("failed"),
        markRunStopped: () => lifecycle.push("stopped"),
        now: () => 0,
        recordCleanupUnresolved: (_config, issues) => {
          recordedUnresolved = issues;
        },
        sessionLiveness: () => "dead",
        tmuxIdentity: () => ({
          session: config.session,
          socket: "/private/tmp/d15-survivor.sock",
        }),
      },
      "ordinary teardown"
    );

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(cleanupResult).toEqual({
      killed: [],
      skipped: [{ pid, reason: "survived-kill" }],
      unresolved: [{ pid, reason: "survived-kill" }],
    });
    expect(recordedUnresolved).toEqual([{ pid, reason: "survived-kill" }]);
    expect(existsSync(processPath)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(runDir, "run-processes", "unresolved-cleanup.json"),
          "utf8"
        )
      )
    ).toMatchObject({ unresolved: [{ pid, reason: "survived-kill" }] });
    expect(lifecycle).toEqual(["failed"]);
  } finally {
    Object.assign(runProcessCleanupInternals.deps, original);
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("cleanup failure cannot prevent explicit tmux teardown", () => {
  const config = handoverConfig();
  const order: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => order.push("log"),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      throw new Error("cleanup unavailable");
    },
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    markRunFailed: () => order.push("fail"),
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    recordCleanupUnresolved: () => undefined,
    sessionLiveness: () => "dead" as const,
    tmuxIdentity: () => ({ session: config.session, socket: "fixture" }),
  };

  stopGovernessLoop(config, deps, "user requested teardown");

  expect(order).toEqual(["log", "cleanup", "log", "kill", "fail", "log"]);
});

test("explicit teardown returns and records an unconfirmed tmux kill", () => {
  const config = handoverConfig();
  const events: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      events.push((record as { event: string }).event),
    cleanupRunProcesses: () => ({ killed: [], skipped: [] }),
    fenceCurrent: () => true,
    killSession: () => {
      throw new TmuxControlUnavailableError([
        "kill-session",
        "-t",
        config.session,
      ]);
    },
    markRunFailed: () => events.push("failed"),
    markRunStopped: () => events.push("mark"),
    now: () => 0,
    recordCleanupUnresolved: () => undefined,
    sessionLiveness: () => "unknown" as const,
    tmuxIdentity: () => ({ session: config.session, socket: "fixture" }),
  };

  expect(() =>
    stopGovernessLoop(config, deps, "user requested teardown")
  ).not.toThrow();
  expect(events).toEqual([
    "exit",
    "tmux-session-kill-unconfirmed",
    "failed",
    "run-cleanup-unresolved",
  ]);
});

class FakeTty extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = false;

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}

test("raw key input emits individual keys and restores the terminal", async () => {
  const input = new FakeTty();
  const keys = openRawKeyInput(input as never);
  expect(keys).toBeDefined();
  expect(input.isRaw).toBe(true);
  input.emit("data", "xh");
  expect(await keys?.next()).toBe("x");
  expect(await keys?.next()).toBe("h");
  keys?.close();
  expect(input.isRaw).toBe(false);
  expect(input.paused).toBe(true);
  expect(input.listenerCount("data")).toBe(0);
});

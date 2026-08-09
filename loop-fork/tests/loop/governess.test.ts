import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendDelegationEvent,
  makeDelegationEvent,
} from "../../src/loop/delegation-policy";
import {
  agentRenameEnabledFromEnv,
  applyGovernessPaneIdentity,
  authoritativeSummaryObjective,
  type BridgeSendStatus,
  composeGovernessPaneTitle,
  composeGovernessRunIdentity,
  composePaneTitle,
  defaultGovernessDeps,
  freshRunState,
  type GovernessConfig,
  type GovernessDeps,
  governessFrameDelta,
  governessInitialFrame,
  governessPaneIdentityTmuxCommands,
  governessTick,
  loadGovernessState,
  maybeBeginSessionPressureHandover,
  refreshGovernessAgentBindings,
  resolveGovernessConfig,
  runGoverness,
  saveGovernessState,
  sendRenameCommands,
} from "../../src/loop/governess";

import type { EscalationEvent } from "../../src/loop/governess-notify";
import {
  appendNativeFallbackRequest,
  createNativeFallbackRequest,
  processPendingNativeFallbackRequests,
} from "../../src/loop/native-subagent";
import {
  createRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import { evaluateSessionPressure } from "../../src/loop/session-pressure";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import { TmuxControlUnavailableError } from "../../src/loop/tmux-control";
import {
  createManifestHandle,
  createTmuxSkipSink,
  describeTmuxTarget,
  manifestSocketState,
  paneTargetFromManifest,
  targetFromManifest,
} from "../../src/loop/tmux-socket";
import type {
  Agent,
  AgentLivenessState,
  AgentUsage,
  HookEvent,
  JudgeOutcome,
  JudgeRequest,
  RecoveryHistoryEntry,
  RoleBalanceRequest,
} from "../../src/loop/types";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

test("summary objective prefers the current loop heading over a terse follow-up", () => {
  expect(
    authoritativeSummaryObjective([
      "# Loop-57 — EXECUTION: increase helper throughput",
      "check now",
      "fixs them",
    ])
  ).toBe("Loop-57 — EXECUTION: increase helper throughput");
});

test("summary objective ignores a newer bridge helper result", () => {
  expect(
    authoritativeSummaryObjective([
      "Task: Loop-57 — EXECUTION: increase helper throughput",
      "fix it",
      "[bridge type=handover task=abc] Helper: result ## Notes on other matches",
    ])
  ).toBe("Loop-57 — EXECUTION: increase helper throughput");
});

const IDLE_MS = 60_000;
const START_MS = 1_000_000;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

test("governess observes agents through persisted post-split pane targets", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-panes-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("91", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cavemanMode: "full",
      cwd,
      driverEffort: "low",
      helperCavemanMode: "ultra",
      mode: "paired",
      pid: 1234,
      repoId: storage.repoId,
      reviewerEffort: "high",
      runId: "91",
      status: "running",
      tmuxPaneLeft: "repo-loop-91:0.0",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRight: "repo-loop-91:0.2",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-91",
    })
  );

  try {
    const config = resolveGovernessConfig("91", {}, cwd, home);
    expect(config.agents.map(({ agent, pane }) => ({ agent, pane }))).toEqual([
      { agent: "claude", pane: "repo-loop-91:0.0" },
      { agent: "codex", pane: "repo-loop-91:0.2" },
    ]);
    expect(config.cavemanMode).toBe("full");
    expect(config.driverEffort).toBe("low");
    expect(config.helperCavemanMode).toBe("ultra");
    expect(config.reviewerEffort).toBe("high");
    expect(config.sessionPressureMode).toBe("enforce");
    expect(
      resolveGovernessConfig(
        "91",
        { LOOP_GOVERNESS_CONTEXT_HANDOFF: "observe" },
        cwd,
        home
      ).sessionPressureMode
    ).toBe("observe");
    expect(
      resolveGovernessConfig(
        "91",
        { LOOP_GOVERNESS_CONTEXT_HANDOFF: "off" },
        cwd,
        home
      ).sessionPressureMode
    ).toBe("off");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governess config resolution does not rewrite restored topology", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-roundtrip-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("101", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeChannelServer: "loop-bridge-harvto-101",
      claudeSessionId: "claude-session-101",
      codexThreadId: "codex-thread-101",
      cwd,
      governess: true,
      mode: "paired",
      pid: 4405,
      repoId: storage.repoId,
      runId: "101",
      state: "working",
      tmuxPaneAuPair: "%3",
      tmuxPaneGoverness: "%2",
      tmuxPaneLeft: "%0",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneNanny: "%4",
      tmuxPaneRecon: ["%5", "%6", "%7"],
      tmuxPaneRight: "%1",
      tmuxPaneRightAgent: "codex",
      tmuxPaneUtility: "%3",
      tmuxSession: "harvto-loop-101",
    })
  );
  const before = readFileSync(storage.manifestPath, "utf8");

  try {
    const config = resolveGovernessConfig("101", {}, cwd, home);
    expect(config.session).toBe("harvto-loop-101");
    expect(config.agents.map(({ agent, pane }) => ({ agent, pane }))).toEqual([
      { agent: "claude", pane: "%0" },
      { agent: "codex", pane: "%1" },
    ]);
    expect(readFileSync(storage.manifestPath, "utf8")).toBe(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governess rejects persisted panes without their agent ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-topology-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("101", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      pid: 4405,
      repoId: storage.repoId,
      runId: "101",
      state: "working",
      tmuxPaneLeft: "%0",
      tmuxPaneRight: "%1",
      tmuxSession: "harvto-loop-101",
    })
  );

  try {
    expect(() => resolveGovernessConfig("101", {}, cwd, home)).toThrow(
      "incomplete tmux agent topology"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governess refreshes late and changed agent session bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-bindings-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("92", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  const manifest = createRunManifest({
    cwd,
    mode: "paired",
    pid: 1234,
    repoId: storage.repoId,
    runId: "92",
    status: "running",
    tmuxPaneLeftAgent: "claude",
    tmuxPaneRightAgent: "codex",
    tmuxSession: "repo-loop-92",
  });
  writeRunManifest(storage.manifestPath, manifest);

  try {
    const config = resolveGovernessConfig("92", {}, cwd, home);
    expect(config.agents.map((info) => info.sessionRef)).toEqual([
      undefined,
      undefined,
    ]);

    writeRunManifest(storage.manifestPath, {
      ...manifest,
      claudeSessionId: "claude-session-1",
      codexThreadId: "codex-thread-1",
    });
    expect(refreshGovernessAgentBindings(config)).toEqual([
      { agent: "claude", current: "claude-session-1" },
      { agent: "codex", current: "codex-thread-1" },
    ]);
    expect(config.agents.map((info) => info.sessionRef)).toEqual([
      "claude-session-1",
      "codex-thread-1",
    ]);

    writeRunManifest(storage.manifestPath, {
      ...manifest,
      claudeSessionId: "claude-session-1",
      codexThreadId: "codex-thread-2",
    });
    expect(refreshGovernessAgentBindings(config)).toEqual([
      {
        agent: "codex",
        current: "codex-thread-2",
        previous: "codex-thread-1",
      },
    ]);
    expect(config.agents[1]?.sessionRef).toBe("codex-thread-2");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governess preserves known bindings across empty or malformed manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-bindings-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("93", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  const manifest = createRunManifest({
    claudeSessionId: "claude-session-1",
    codexThreadId: "codex-thread-1",
    cwd,
    mode: "paired",
    pid: 1234,
    repoId: storage.repoId,
    runId: "93",
    status: "running",
    tmuxPaneLeftAgent: "claude",
    tmuxPaneRightAgent: "codex",
    tmuxSession: "repo-loop-93",
  });
  writeRunManifest(storage.manifestPath, manifest);

  try {
    const config = resolveGovernessConfig("93", {}, cwd, home);
    writeRunManifest(storage.manifestPath, {
      ...manifest,
      claudeSessionId: "",
      codexThreadId: "",
    });
    expect(refreshGovernessAgentBindings(config)).toEqual([]);
    expect(config.agents.map((info) => info.sessionRef)).toEqual([
      "claude-session-1",
      "codex-thread-1",
    ]);

    writeFileSync(storage.manifestPath, "{not-json", "utf8");
    expect(refreshGovernessAgentBindings(config)).toEqual([]);
    expect(config.agents.map((info) => info.sessionRef)).toEqual([
      "claude-session-1",
      "codex-thread-1",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

const stripAnsi = (text: string): string => text.replace(ANSI_RE, "");

const usage = (overrides: Partial<AgentUsage> = {}): AgentUsage => ({
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  compactedContextTokens: 0,
  compactions: 0,
  contextRateTokensPerMinute: 0,
  contextTokens: 0,
  contextWindow: 200_000,
  costRateUsdPerHour: 0,
  creditCostMultiplier: 1,
  costUsd: 0,
  dataConfidence: "none",
  humanMessages: 0,
  inputTokens: 0,
  messages: 0,
  outputTokens: 0,
  textMessages: 0,
  thinkingMessages: 0,
  toolCalls: 0,
  toolCallCounts: {},
  totalTokens: 0,
  ...overrides,
});

const baseConfig = (
  overrides: Partial<GovernessConfig> = {}
): GovernessConfig => ({
  agentRenameEnabled: false,
  agents: [{ agent: "claude", hookFile: "hooks.jsonl", pane: "s:0.0" }],
  budgetUsd: 0,
  confidence: 0.7,
  cooldownMs: 300_000,
  dryRun: false,
  driverEffort: "medium",
  epoch: 1,
  escalateIdleMs: 300_000,
  idleMs: IDLE_MS,
  logFile: "governess.jsonl",
  llmDecodeConcurrency: 32,
  llmPrefillStepSize: 2048,
  llmPromptCacheSlots: 10,
  llmPromptConcurrency: 8,
  judgeMode: "consensus",
  maxRecoveries: 3,
  model: "m",
  roleBalanceEnabled: false,
  reviewerEffort: "medium",
  runId: "1",
  session: "s",
  tickMs: 15_000,
  url: "http://127.0.0.1:8082",
  usageTrackerTimeoutMs: 1500,
  ...overrides,
});

interface Spies {
  bridgeMessages: {
    message: string;
    runDir: string;
    source: Agent;
    status: BridgeSendStatus;
    target: Agent;
  }[];
  governessPaneIdentities: [string, string][];
  judged: number;
  judgeRequests: JudgeRequest[];
  logs: unknown[];
  notifies: EscalationEvent[];
  paneBorderInits: string[];
  paneLabels: [string, string][];
  respawns: string[];
  roleBalanceRequests: RoleBalanceRequest[];
  sends: string[][];
  texts: string[];
}

const makeDeps = (
  outcome: JudgeOutcome,
  clock: { ms: number },
  spies: Spies
): GovernessDeps => ({
  appendLog: (_file, record) => spies.logs.push(record),
  assessRoleBalance: (req) => {
    spies.roleBalanceRequests.push(req);
    return Promise.resolve({
      confidence: 0,
      reason: "",
      switchDriver: false,
      tokens: 0,
    });
  },
  assessWaiting: () => Promise.resolve({ ask: "", tokens: 0, waiting: false }),
  capturePane: () => "stable pane text",
  fenceCurrent: () => true,
  initPaneBorders: (session) => spies.paneBorderInits.push(session),
  judge: (req) => {
    spies.judged += 1;
    spies.judgeRequests.push(req);
    return Promise.resolve(outcome);
  },
  labelPanes: () => Promise.resolve({ labels: {}, tokens: 0 }),
  loadState: () => undefined,
  notify: (_url, event) => spies.notifies.push(event),
  now: () => clock.ms,
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
    contextTokens: 0,
    contextRateTokensPerMinute: 0,
    contextWindow: 200_000,
    costRateUsdPerHour: 0,
    costUsd: 0,
    dataConfidence: "exact",
    humanMessages: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    textMessages: 0,
    thinkingMessages: 0,
    toolCalls: 0,
    toolCallCounts: {},
    totalTokens: 0,
  }),
  readUsageLimits: () => Promise.resolve(undefined),
  replacementSessionReady: () => false,
  render: () => {
    // no-op for tests
  },
  respawnPane: (pane) => spies.respawns.push(pane),
  saveState: () => {
    // no-op for tests
  },
  sendBridge: (runDir, source, target, message) => {
    const status = "accepted";
    spies.bridgeMessages.push({ message, runDir, source, status, target });
    return Promise.resolve(status);
  },
  sendKeys: (pane, keys) => spies.sends.push([pane, ...keys]),
  sendText: (_pane, text) => spies.texts.push(text),
  setPaneLabel: (pane, label) => spies.paneLabels.push([pane, label]),
  setGovernessPaneIdentity: (pane, label) =>
    spies.governessPaneIdentities.push([pane, label]),
  sleep: () => Promise.resolve(),
  summarize: () => Promise.resolve({ text: "", tokens: 0 }),
});

const freshSpies = (): Spies => ({
  bridgeMessages: [],
  judgeRequests: [],
  judged: 0,
  logs: [],
  notifies: [],
  paneBorderInits: [],
  governessPaneIdentities: [],
  paneLabels: [],
  respawns: [],
  roleBalanceRequests: [],
  sends: [],
  texts: [],
});

const withSafeTurnEnd = (deps: GovernessDeps): GovernessDeps => ({
  ...deps,
  readHooks: () => [
    {
      agent: "claude",
      event: "Stop",
      ts: new Date(START_MS).toISOString(),
    },
  ],
});

const stuck: JudgeOutcome = {
  ok: true,
  verdict: { confidence: 0.9, state: "stuck", summary: "stuck on build" },
};

test("context preparation is action-oriented, durable, and sent once per agent", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsage: (agent) =>
      agent === "codex"
        ? usage({
            contextTokens: 138_750,
            messages: 1,
            model: "gpt-5.6-sol",
          })
        : usage({ contextTokens: 10_000, messages: 1, model: "Claude Opus 5" }),
  };
  const config = baseConfig({
    agents: [
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
    ],
    runDir: "/run",
    sessionPressureMode: "enforce",
  });
  const states = new Map<Agent, AgentLivenessState>();
  const first = await governessTick(states, config, deps);

  expect(first.sessionPressure.codex).toMatchObject({
    phase: "prepare",
    reasonCode: "context-prepare",
  });
  expect(spies.bridgeMessages).toHaveLength(2);
  expect(
    spies.bridgeMessages.every((entry) =>
      entry.message.startsWith("governess: prepare a fresh-loop handover now")
    )
  ).toBe(true);
  expect(
    spies.bridgeMessages.every((entry) => !entry.message.includes("/compact"))
  ).toBe(true);
  expect(first.runState.sessionPressurePrepared).toEqual({
    claude: true,
    codex: true,
  });
  expect(
    spies.logs.filter(
      (entry) =>
        (entry as { event?: string }).event === "session-pressure-transition"
    )
  ).toHaveLength(1);

  await governessTick(states, config, deps, first.runState);
  expect(spies.bridgeMessages).toHaveLength(2);
});

test("session pressure state survives Governess persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-session-pressure-state-"));
  const stateFile = join(root, "governess-state.json");
  const state = freshRunState();
  state.sessionPressure.codex = evaluateSessionPressure(
    "codex",
    usage({ contextTokens: 138_750, model: "gpt-5.6-sol" })
  );
  state.sessionPressurePrepared.codex = true;
  saveGovernessState(stateFile, state);
  try {
    const loaded = loadGovernessState(stateFile);
    expect(loaded?.sessionPressure.codex).toEqual(state.sessionPressure.codex);
    expect(loaded?.sessionPressurePrepared).toEqual({ codex: true });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("pressure-triggered handover pins its epoch across Governess persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-pressure-handover-epoch-"));
  const stateFile = join(root, "governess-state.json");
  const state = freshRunState();
  state.governessEpoch = 41;
  const due = evaluateSessionPressure(
    "codex",
    usage({ contextTokens: 185_000, model: "gpt-5.6-sol" })
  );
  const deps = {
    appendLog: () => undefined,
    now: () => START_MS,
  };

  expect(
    maybeBeginSessionPressureHandover(
      {
        dryRun: false,
        logFile: "governess.jsonl",
        sessionPressureMode: "enforce",
      },
      deps,
      state,
      { codex: due },
      true
    )
  ).toEqual(due);
  expect(state.exitControl).toMatchObject({
    handoverEpoch: 41,
    mode: "handover",
  });

  saveGovernessState(stateFile, state);
  try {
    const restarted = loadGovernessState(stateFile);
    expect(restarted?.exitControl).toMatchObject({
      handoverEpoch: 41,
      mode: "handover",
    });
    if (!restarted) {
      throw new Error("expected persisted Governess state");
    }
    restarted.governessEpoch = 99;
    expect(
      maybeBeginSessionPressureHandover(
        {
          dryRun: false,
          logFile: "governess.jsonl",
          sessionPressureMode: "enforce",
        },
        deps,
        restarted,
        { codex: due },
        true
      )
    ).toBeUndefined();
    expect(restarted.exitControl.handoverEpoch).toBe(41);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("enforce starts exactly one governed handover while safety modes do not", () => {
  const due = evaluateSessionPressure(
    "codex",
    usage({ contextTokens: 185_000, model: "gpt-5.6-sol" })
  );
  const logs: unknown[] = [];
  const deps = {
    appendLog: (_file: string, record: unknown) => logs.push(record),
    now: () => START_MS,
  };
  const enforced = freshRunState();
  expect(
    maybeBeginSessionPressureHandover(
      {
        dryRun: false,
        logFile: "governess.jsonl",
        sessionPressureMode: "enforce",
      },
      deps,
      enforced,
      { codex: due },
      true
    )
  ).toEqual(due);
  expect(enforced.exitControl).toMatchObject({
    mode: "handover",
    requestedAt: new Date(START_MS).toISOString(),
  });
  expect(
    maybeBeginSessionPressureHandover(
      {
        dryRun: false,
        logFile: "governess.jsonl",
        sessionPressureMode: "enforce",
      },
      deps,
      enforced,
      { codex: due },
      true
    )
  ).toBeUndefined();
  expect(logs).toHaveLength(1);

  for (const sessionPressureMode of ["observe", "off"] as const) {
    const state = freshRunState();
    expect(
      maybeBeginSessionPressureHandover(
        { dryRun: false, logFile: "x", sessionPressureMode },
        deps,
        state,
        { codex: due },
        true
      )
    ).toBeUndefined();
    expect(state.exitControl.mode).toBe("idle");
  }
  const dryRun = freshRunState();
  expect(
    maybeBeginSessionPressureHandover(
      {
        dryRun: true,
        logFile: "x",
        sessionPressureMode: "enforce",
      },
      deps,
      dryRun,
      { codex: due },
      true
    )
  ).toBeUndefined();
  expect(dryRun.exitControl.mode).toBe("idle");
});

// Drive two ticks: the first seeds detector state, the second (after the pane
// has been stable past the idle window with no events) makes the agent suspect.
const runToSuspect = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  clock: { ms: number }
) => {
  const states = new Map<Agent, AgentLivenessState>();
  const first = await governessTick(states, config, deps);
  clock.ms = START_MS + 2 * IDLE_MS;
  return governessTick(states, config, deps, first.runState);
};

test("suspect + stuck in dry-run: judges and decides but executes nothing", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies);
  const result = await runToSuspect(
    baseConfig({ dryRun: true, llmTraceFile: "llm-trace.jsonl" }),
    deps,
    clock
  );

  expect(spies.judged).toBe(1);
  expect(spies.judgeRequests[0]?.traceFile).toBe("llm-trace.jsonl");
  expect(spies.sends).toHaveLength(0);
  expect(spies.respawns).toHaveLength(0);
  expect(result.runState.history).toHaveLength(0); // dry-run does not record history
  expect(
    spies.logs.some((r) => (r as { kind: string }).kind === "decision")
  ).toBe(true);
});

test("suspect + stuck live: executes the first ladder rung and records history", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies);
  const result = await runToSuspect(baseConfig({ dryRun: false }), deps, clock);

  // answer-prompt rung => a single Enter keystroke to the agent pane
  expect(spies.sends).toEqual([["s:0.0", "Enter"]]);
  expect(result.runState.history).toHaveLength(1);
  expect(result.runState.history[0].level).toBe("answer-prompt");
});

test("LLM unreachable suppresses recovery and flags the board", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const outcome: JudgeOutcome = {
    fallback: { confidence: 0, state: "working", summary: "" },
    ok: false,
    reason: "unreachable",
  };
  const deps = makeDeps(outcome, clock, spies);
  const result = await runToSuspect(baseConfig(), deps, clock);

  expect(result.llmOffline).toBe(true);
  expect(spies.sends).toHaveLength(0);
  expect(spies.respawns).toHaveLength(0);
  expect(stripAnsi(result.board)).toContain("nanny model · m · offline");
  expect(stripAnsi(result.board)).not.toContain("qwen");
});

test("dual local judges render separate token rows and require agreement", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    judge: (req) => {
      spies.judged += 1;
      spies.judgeRequests.push(req);
      const isQwen = req.model === "qwen";
      return Promise.resolve({
        ok: true,
        usage: {
          cachedInputTokens: isQwen ? 80 : 40,
          calls: 1,
          inputTokens: isQwen ? 120 : 70,
          outputTokens: isQwen ? 30 : 20,
          totalTokens: isQwen ? 150 : 90,
        },
        verdict: {
          confidence: isQwen ? 0.9 : 0.8,
          state: isQwen ? "stuck" : "working",
          summary: isQwen ? "stuck" : "still moving",
        },
      });
    },
  };
  const result = await runToSuspect(
    baseConfig({
      judges: [
        { id: "qwen", model: "qwen", url: "http://qwen" },
        { id: "gemma", model: "gemma", url: "http://gemma" },
      ],
    }),
    deps,
    clock
  );
  const visibleBoard = stripAnsi(result.board);

  expect(spies.judgeRequests.map((req) => req.model).sort()).toEqual([
    "gemma",
    "qwen",
  ]);
  expect(spies.sends).toHaveLength(0);
  expect(visibleBoard).toContain(
    "nanny model · qwen · ok · 1 calls · 150 tok (i120 c80 o30)"
  );
  expect(visibleBoard).toContain(
    "nanny model · gemma · ok · 1 calls · 90 tok (i70 c40 o20)"
  );
  expect(visibleBoard).toContain("● working");
});

test("small panes collapse excess judge rows within the viewport budget", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const result = await governessTick(
    new Map(),
    baseConfig({
      judges: ["qwen", "gemma", "llama", "mistral"].map((id) => ({
        id,
        model: id,
        url: `http://${id}`,
      })),
      viewportRows: 8,
    }),
    makeDeps(stuck, clock, spies)
  );
  const board = stripAnsi(result.board);
  expect(board.split("\n").length).toBeLessThanOrEqual(8);
  expect(board).toContain("qwen");
  expect(board).toContain("2 more judges");
  expect(board).not.toContain("mistral");
});

test("round-robin local judge mode calls one model for that tick", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    judge: (req) => {
      spies.judged += 1;
      spies.judgeRequests.push(req);
      return Promise.resolve({
        ok: true,
        usage: {
          cachedInputTokens: 12,
          calls: 1,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
        verdict: { confidence: 0.9, state: "stuck", summary: "stuck" },
      });
    },
  };
  const result = await runToSuspect(
    baseConfig({
      judgeMode: "round-robin",
      judges: [
        { id: "qwen", model: "qwen", url: "http://qwen" },
        { id: "gemma", model: "gemma", url: "http://gemma" },
      ],
    }),
    deps,
    clock
  );
  const visibleBoard = stripAnsi(result.board);

  // runToSuspect judges on tick 2, so two judges rotate to gemma.
  expect(spies.judgeRequests.map((req) => req.model)).toEqual(["gemma"]);
  expect(spies.sends).toEqual([["s:0.0", "Enter"]]);
  expect(visibleBoard).toContain(
    "nanny model · gemma · ok · 1 calls · 120 tok (i100 c12 o20)"
  );
  expect(visibleBoard).not.toContain("judge round-robin");
  expect(visibleBoard).not.toContain("llm params");
  expect(visibleBoard).toContain("temp 0");
});

test("board labels an agent [thinking] while its pane is animating", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  let frame = 0;
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    capturePane: () => `frame ${frame++}`, // pane changes every tick
  };
  const states = new Map<Agent, AgentLivenessState>();
  await governessTick(states, baseConfig(), deps);
  clock.ms = START_MS + 2 * IDLE_MS;
  const result = await governessTick(states, baseConfig(), deps);
  expect(result.board).toContain("thinking");
});

test("board keeps the configured leader row first", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  let codexFrame = 0;
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    capturePane: (pane) =>
      pane === "s:0.1" ? `codex frame ${codexFrame++}` : "claude idle",
    readUsage: (agent) =>
      usage({
        messages: agent === "codex" ? 20 : 5,
        totalTokens: agent === "codex" ? 20_000 : 5000,
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
    ],
  });
  await governessTick(states, config, deps);
  clock.ms = START_MS + config.tickMs + 1;
  const result = await governessTick(states, config, deps);
  const visibleLines = stripAnsi(result.board).split("\n");
  const headerIndex = visibleLines.findIndex((line) => line.includes("AGENT"));

  expect(headerIndex).toBeGreaterThanOrEqual(0);
  expect(visibleLines[headerIndex + 1]).toStartWith(" claude");
  expect(visibleLines[headerIndex + 2]).toStartWith(" codex");
});

test("codex session pressure hands driver role to claude until reset", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () =>
      Promise.resolve({
        codex: {
          primaryPct: 98,
          primaryReset: "Jan 12 1:00 PM",
          secondaryPct: 50,
          secondaryReset: "Jan 13 6:00 PM",
        },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    limitHandoffEnabled: true,
  });
  const result = await governessTick(states, config, deps);
  const visibleLines = stripAnsi(result.board).split("\n");
  const headerIndex = visibleLines.findIndex((line) => line.includes("AGENT"));

  expect(spies.texts).toHaveLength(1);
  expect(spies.bridgeMessages).toHaveLength(0);
  expect(spies.texts[0]).toContain("Codex is at/near session limit");
  expect(spies.texts[0]).toContain("Claude is now the driver");
  expect(spies.texts[0]).toContain("do not wait for Codex");
  expect(spies.sends).toEqual([["s:0.1", "Enter"]]);
  expect(result.runState.notified.limitHandoff.codex).toBe(
    "session:Jan 12 1:00 PM"
  );
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  expect(visibleLines[headerIndex + 1]).toStartWith(" claude");
  expect(visibleLines[headerIndex + 2]).toStartWith(" codex");
  expect(stripAnsi(result.board)).not.toContain("waiting for you");
  expect(stripAnsi(result.board)).toContain("paused codex");
  expect(stripAnsi(result.board)).toContain("handoff 0s ago");
  expect(stripAnsi(result.board)).not.toContain("roles · initial");
  expect(stripAnsi(result.board)).toContain("msgs claude 1 codex 0");
  expect(stripAnsi(result.board)).not.toMatch(/\n roles ·/);
});

test("codex limit handoff does not repeat when reset detail appears later", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () =>
      Promise.resolve({
        codex: {
          primaryPct: 100,
          primaryReset: "Jan 12 1:00 PM",
        },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    limitHandoffEnabled: true,
  });
  const result = await governessTick(states, config, deps, {
    ...freshRunState(),
    notified: {
      ...freshRunState().notified,
      limitHandoff: { codex: "session:unknown" },
    },
  });

  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toHaveLength(0);
  expect(result.runState.notified.limitHandoff.codex).toBe(
    "session:Jan 12 1:00 PM"
  );
  expect(result.runState.roles.currentDriver).toBe("claude");
  expect(result.runState.roles.pausedAgent).toBe("codex");
});

test("codex limit reset restores driver role without compacting context", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readHooks: () => [
      {
        agent: "codex",
        event: "Stop",
        ts: new Date(START_MS).toISOString(),
      },
    ],
    readUsageLimits: () => Promise.resolve({}),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    initialDriver: "codex",
    runDir: "run-dir",
  });
  const result = await governessTick(states, config, deps, {
    ...freshRunState(),
    notified: {
      ...freshRunState().notified,
      limitHandoff: { codex: "session:Jan 12 1:00 PM" },
    },
    roles: {
      currentDriver: "claude",
      handoffAt: new Date(START_MS - 60_000).toISOString(),
      initialDriver: "codex",
      lastAction: "handoff",
      pausedAgent: "codex",
      pressureMissingAt: new Date(START_MS - 300_001).toISOString(),
      pressureKey: "session:Jan 12 1:00 PM",
      reset: "1960-01-01T00:00:00Z",
      resetKind: "session",
      temporaryDriver: "claude",
    },
    summary:
      "Project: demo\nObjective: keep going\nProgress: Claude fixed measured inputs\nNext: Codex verify calibration",
  });

  expect(spies.bridgeMessages).toHaveLength(2);
  expect(spies.bridgeMessages[0]).toMatchObject({
    runDir: "run-dir",
    source: "claude",
    status: "accepted",
    target: "codex",
  });
  expect(spies.bridgeMessages[0]?.message).toStartWith("governess:");
  expect(spies.bridgeMessages[0]?.message).not.toContain("/compact");
  expect(spies.bridgeMessages[0]?.message).toContain("Codex's limit reset");
  expect(spies.bridgeMessages[0]?.message).toContain("Claude drove the task");
  expect(spies.bridgeMessages[0]?.message).toContain(
    "Claude fixed measured inputs"
  );
  expect(spies.bridgeMessages[1]).toMatchObject({
    runDir: "run-dir",
    source: "codex",
    status: "accepted",
    target: "claude",
  });
  expect(spies.bridgeMessages[1]?.message).toContain(
    "Hand the driver role back to Codex"
  );
  expect(spies.texts).toEqual([]);
  expect(spies.sends).toEqual([]);
  expect(result.runState.notified.limitHandoff.codex).toBeUndefined();
  expect(result.runState.roles.currentDriver).toBe("codex");
  expect(result.runState.roles.pausedAgent).toBeUndefined();
  expect(stripAnsi(result.board)).toContain("restored 0s ago");
  expect(stripAnsi(result.board)).not.toContain("roles · initial");
  expect(stripAnsi(result.board)).toContain("msgs codex 1 claude 1");
  expect(stripAnsi(result.board)).not.toMatch(/\n roles ·/);
});

test("handover mode suppresses pending limit role-transition messages", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readHooks: () => [
      {
        agent: "codex",
        event: "Stop",
        ts: new Date(START_MS).toISOString(),
      },
    ],
    readUsageLimits: () => Promise.resolve({}),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig({
      agents: [
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
      ],
      initialDriver: "codex",
      runDir: "run-dir",
    }),
    deps,
    {
      ...freshRunState(),
      exitControl: {
        mode: "handover",
        notified: {},
        requestedAt: new Date(START_MS).toISOString(),
      },
      notified: {
        ...freshRunState().notified,
        limitHandoff: { codex: "session:Jan 12 1:00 PM" },
      },
      roles: {
        currentDriver: "claude",
        initialDriver: "codex",
        lastAction: "handoff",
        pausedAgent: "codex",
        pressureMissingAt: new Date(START_MS - 300_001).toISOString(),
        reset: "1960-01-01T00:00:00Z",
        resetKind: "session",
        temporaryDriver: "claude",
      },
    }
  );

  expect(spies.bridgeMessages).toEqual([]);
  expect(spies.texts).toEqual([]);
  expect(spies.sends).toEqual([]);
  expect(result.runState.roles.currentDriver).toBe("claude");
  expect(result.runState.roles.pausedAgent).toBe("codex");
  expect(result.runState.notified.limitHandoff.codex).toBe(
    "session:Jan 12 1:00 PM"
  );
});

test("a missing limit snapshot does not restore before a known future reset", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () => Promise.resolve({}),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig({
      agents: [
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
      ],
      initialDriver: "codex",
      runDir: "run-dir",
    }),
    deps,
    {
      ...freshRunState(),
      notified: {
        ...freshRunState().notified,
        limitHandoff: { codex: "weekly:Jan 12 1:00 PM" },
      },
      roles: {
        currentDriver: "claude",
        initialDriver: "codex",
        lastAction: "handoff",
        pausedAgent: "codex",
        reset: "Jan 12 1:00 PM",
        resetKind: "weekly",
        temporaryDriver: "claude",
      },
    }
  );

  expect(spies.bridgeMessages).toHaveLength(0);
  expect(spies.texts).toHaveLength(0);
  expect(result.runState.roles.pausedAgent).toBe("codex");
  expect(result.runState.roles.pressureMissingAt).toBeUndefined();
  expect(result.runState.notified.limitHandoff.codex).toBe(
    "weekly:Jan 12 1:00 PM"
  );
});

test("one missing limit snapshot starts a cooldown instead of restoring", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () => Promise.resolve({}),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig({
      agents: [
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
      ],
      initialDriver: "codex",
      runDir: "run-dir",
    }),
    deps,
    {
      ...freshRunState(),
      notified: {
        ...freshRunState().notified,
        limitHandoff: { codex: "session:unknown" },
      },
      roles: {
        currentDriver: "claude",
        initialDriver: "codex",
        lastAction: "handoff",
        pausedAgent: "codex",
        temporaryDriver: "claude",
      },
    }
  );

  expect(spies.bridgeMessages).toHaveLength(0);
  expect(spies.texts).toHaveLength(0);
  expect(result.runState.roles.pausedAgent).toBe("codex");
  expect(result.runState.roles.pressureMissingAt).toBe(
    new Date(START_MS).toISOString()
  );
});

test("restore briefing stays pending while its target is active", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () => Promise.resolve({}),
  };
  const states = new Map<Agent, AgentLivenessState>([
    [
      "codex",
      {
        agent: "codex",
        paneHash: "previous-codex-pane",
        paneStableSinceMs: START_MS - IDLE_MS,
      },
    ],
  ]);
  const result = await governessTick(
    states,
    baseConfig({
      agents: [
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
      ],
      initialDriver: "codex",
      runDir: "run-dir",
    }),
    deps,
    {
      ...freshRunState(),
      notified: {
        ...freshRunState().notified,
        limitHandoff: { codex: "session:unknown" },
      },
      roles: {
        currentDriver: "claude",
        initialDriver: "codex",
        lastAction: "handoff",
        pausedAgent: "codex",
        pressureMissingAt: new Date(START_MS - 300_001).toISOString(),
        temporaryDriver: "claude",
      },
    }
  );

  expect(spies.bridgeMessages).toHaveLength(0);
  expect(spies.texts).toHaveLength(0);
  expect(result.runState.roles.pausedAgent).toBe("codex");
});

test("pressure on a non-driver is deduped without messaging or a handoff", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () =>
      Promise.resolve({
        codex: {
          secondaryPct: 99,
          secondaryReset: "Jan 12 1:00 PM",
        },
      }),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
      ],
      initialDriver: "claude",
    }),
    deps
  );

  expect(spies.bridgeMessages).toHaveLength(0);
  expect(spies.texts).toHaveLength(0);
  expect(result.runState.roles.currentDriver).toBeUndefined();
  expect(result.runState.roles.pausedAgent).toBeUndefined();
  expect(result.runState.notified.limitHandoff.codex).toBe(
    "weekly:Jan 12 1:00 PM"
  );
});

test("claude session pressure hands driver role to codex until reset", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readUsageLimits: () =>
      Promise.resolve({
        claude: {
          primaryPct: 97,
          primaryReset: "Jan 12 2:00 PM",
          secondaryPct: 30,
          secondaryReset: "Jan 13 6:00 PM",
        },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
    ],
    limitHandoffEnabled: true,
    runDir: "run-dir",
  });
  const result = await governessTick(states, config, deps);
  const visibleLines = stripAnsi(result.board).split("\n");
  const headerIndex = visibleLines.findIndex((line) => line.includes("AGENT"));

  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toEqual([]);
  expect(spies.bridgeMessages).toHaveLength(1);
  expect(spies.bridgeMessages[0]).toMatchObject({
    runDir: "run-dir",
    source: "claude",
    status: "accepted",
    target: "codex",
  });
  expect(spies.bridgeMessages[0]?.message).toContain(
    "Claude is at/near session limit"
  );
  expect(spies.bridgeMessages[0]?.message).toContain("Codex is now the driver");
  expect(spies.bridgeMessages[0]?.message).toContain("do not wait for Claude");
  expect(result.runState.notified.limitHandoff.claude).toBe(
    "session:Jan 12 2:00 PM"
  );
  expect(stripAnsi(result.board)).toContain("msgs codex 1 claude 0");
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  expect(visibleLines[headerIndex + 1]).toStartWith(" codex");
  expect(visibleLines[headerIndex + 2]).toStartWith(" claude");
});

test("proactive quota balance is disabled by default", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    assessRoleBalance: (req) => {
      spies.roleBalanceRequests.push(req);
      throw new Error("role balance should not be called");
    },
    readUsageLimits: () =>
      Promise.resolve({
        claude: { primaryPct: 30, secondaryPct: 20 },
        codex: { primaryPct: 84, secondaryPct: 62 },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    initialDriver: "codex",
    runDir: "run-dir",
  });

  const result = await governessTick(states, config, deps);

  expect(spies.roleBalanceRequests).toHaveLength(0);
  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toHaveLength(0);
  expect(spies.bridgeMessages).toHaveLength(0);
  expect(result.runState.roles.currentDriver).toBeUndefined();
  expect(result.runState.roles.balanceCheckKey).toBeUndefined();
  expect(result.runState.llmUsage.totalTokens).toBe(0);
});

test("proactive quota balance moves driver when local LLM approves", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    assessRoleBalance: (req) => {
      spies.roleBalanceRequests.push(req);
      return Promise.resolve({
        confidence: 0.82,
        driver: "claude",
        reason: "Codex session quota is tighter; Claude has enough headroom",
        switchDriver: true,
        tokens: 15,
        usage: {
          cachedInputTokens: 2,
          calls: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      });
    },
    readUsageLimits: () =>
      Promise.resolve({
        claude: { primaryPct: 30, secondaryPct: 20 },
        codex: { primaryPct: 84, secondaryPct: 62 },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    initialDriver: "codex",
    roleBalanceEnabled: true,
    runDir: "run-dir",
  });

  const result = await governessTick(states, config, deps);

  expect(spies.roleBalanceRequests).toHaveLength(1);
  expect(spies.roleBalanceRequests[0]).toMatchObject({
    candidateDriver: "claude",
    currentDriver: "codex",
    initialDriver: "codex",
  });
  expect(spies.texts).toEqual([]);
  expect(spies.sends).toEqual([]);
  expect(spies.bridgeMessages).toHaveLength(2);
  expect(spies.bridgeMessages[0]).toMatchObject({
    runDir: "run-dir",
    source: "codex",
    status: "accepted",
    target: "claude",
  });
  expect(spies.bridgeMessages[0]?.message).toContain(
    "Claude is now the driver"
  );
  expect(spies.bridgeMessages[1]).toMatchObject({
    runDir: "run-dir",
    source: "claude",
    status: "accepted",
    target: "codex",
  });
  expect(spies.bridgeMessages[1]?.message).toContain(
    "Claude is now the driver"
  );
  expect(result.runState.roles.currentDriver).toBe("claude");
  expect(result.runState.roles.lastAction).toBe("balance");
  expect(result.runState.roles.pausedAgent).toBeUndefined();
  expect(result.runState.llmUsage).toMatchObject({
    calls: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  expect(stripAnsi(result.board)).toContain("balance 0s ago");
  expect(stripAnsi(result.board)).not.toContain("roles · initial");
  expect(stripAnsi(result.board)).toContain("balance 0s ago");
  expect(stripAnsi(result.board)).toContain("msgs codex 1 claude 1");
});

test("proactive quota balance is skipped when local LLM vetoes", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    assessRoleBalance: (req) => {
      spies.roleBalanceRequests.push(req);
      return Promise.resolve({
        confidence: 0.7,
        reason: "Codex should finish the current step",
        switchDriver: false,
        tokens: 7,
        usage: {
          cachedInputTokens: 0,
          calls: 1,
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
        },
      });
    },
    readUsageLimits: () =>
      Promise.resolve({
        claude: { primaryPct: 30, secondaryPct: 20 },
        codex: { primaryPct: 84, secondaryPct: 62 },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.0" },
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.1" },
    ],
    initialDriver: "codex",
    roleBalanceEnabled: true,
    runDir: "run-dir",
  });

  const result = await governessTick(states, config, deps);

  expect(spies.roleBalanceRequests).toHaveLength(1);
  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toHaveLength(0);
  expect(spies.bridgeMessages).toHaveLength(0);
  expect(result.runState.roles.currentDriver).toBeUndefined();
  expect(result.runState.roles.balanceCheckKey).toBe(
    "balance:codex->claude:80:30"
  );
  expect(result.runState.llmUsage.totalTokens).toBe(7);
  expect(stripAnsi(result.board)).not.toContain("roles · initial");
  expect(stripAnsi(result.board)).not.toContain("current claude");
});

test("board labels an agent [idle] once its pane is frozen", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  // constant pane text => frozen; a working verdict so no recovery interferes
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps = makeDeps(working, clock, spies);
  const states = new Map<Agent, AgentLivenessState>();
  await governessTick(states, baseConfig(), deps); // seed
  // advance past a tick but under the idle threshold: frozen but not yet suspect
  clock.ms = START_MS + baseConfig().tickMs + 1;
  const result = await governessTick(states, baseConfig(), deps);
  expect(result.board).toContain("idle");
});

test("board converts the agent's live remaining context % to used context", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    capturePane: () => "Opus 4.8 | ctx: 61% | effort: high",
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(states, baseConfig(), deps);
  expect(result.board).toMatch(/78k\/200k\s+39%\s+c0/);
  expect(result.board).not.toContain("122k/200k 61%");
  expect(result.board).toContain("high");
});

test("board ignores narrative effort words and uses the final valid status-line effort", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    capturePane: () =>
      "Audit the effort args first, then check the effort limb.\nOpus 5 | ctx: 80% | effort: medium",
    readUsage: () => ({
      ...makeDeps(working, clock, spies).readUsage("claude", "session"),
      reasoningEffort: "max",
    }),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig(),
    deps
  );
  const board = stripAnsi(result.board);
  expect(board).toContain("med");
  expect(board).not.toContain("args");
  expect(board).not.toContain("limb");
});

test("board preserves provider effort when pane has no recognized effort marker", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const baseDeps = makeDeps(working, clock, spies);
  const deps: GovernessDeps = {
    ...baseDeps,
    capturePane: () => "Discussion only: effort limb and effort args.",
    readUsage: (agent, sessionRef, codexHome) => ({
      ...baseDeps.readUsage(agent, sessionRef, codexHome),
      reasoningEffort: "max",
    }),
  };
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig(),
    deps
  );
  const board = stripAnsi(result.board);
  expect(board).toContain("max");
  expect(board).not.toContain("limb");
  expect(board).not.toContain("args");
});

test("board shows latest bridge messages in both directions", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    readBridge: () => ({
      claude: { codex: 6 },
      codex: { claude: 6 },
    }),
    readBridgeLatest: (runDir) => {
      expect(runDir).toBe("run-dir");
      return {
        claude: {
          codex: {
            at: new Date(START_MS - 30_000).toISOString(),
            id: "m1",
            kind: "message",
            message: "**Review approved**, merge after one `confirmation`.",
            signature: "s1",
            source: "claude",
            target: "codex",
          },
        },
        codex: {
          claude: {
            at: new Date(START_MS - 90_000).toISOString(),
            id: "m2",
            kind: "message",
            message: "Final proof checkpoint.\n\nDelta notes are ready.",
            signature: "s2",
            source: "codex",
            target: "claude",
          },
        },
      };
    },
    readHooks: (file) =>
      file.includes("claude")
        ? [
            {
              agent: "claude",
              detail: "cd /repo && npm test",
              event: "ToolUse",
              tool: "Bash",
              ts: new Date(START_MS - 12_000).toISOString(),
            },
          ]
        : [
            {
              agent: "codex",
              event: "Stop",
              ts: new Date(START_MS - 31_000).toISOString(),
            },
          ],
    readUsage: (agent) =>
      usage({
        humanMessages: agent === "claude" ? 4 : 2,
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
      ],
      runDir: "run-dir",
    }),
    deps
  );
  const visibleBoard = stripAnsi(result.board);

  expect(visibleBoard).toContain("bridge claude→codex");
  expect(visibleBoard).not.toContain("bridge latest");
  expect(visibleBoard).not.toContain("bridge msgs");
  expect(visibleBoard).toContain("human 4 →6 ←6");
  expect(visibleBoard).toContain("human 2 →6 ←6");
  expect(visibleBoard).not.toContain("human 3");
  expect(visibleBoard.match(/bridge claude→codex/g) ?? []).toHaveLength(1);
  expect(visibleBoard.match(/bridge codex→claude/g) ?? []).toHaveLength(0);
  expect(visibleBoard).toContain(
    "bridge claude→codex · 30s · Review approved, merge after one confirmation."
  );
  expect(visibleBoard).toContain(
    "Review approved, merge after one confirmation. · now claude 12s: Bash cd /repo && npm test"
  );
  expect(visibleBoard).toContain(
    "codex→claude · 2m · Final proof checkpoint. Delta notes are ready."
  );
  expect(visibleBoard).toMatch(
    /Final proof checkpoint\. Delta notes are ready\. · now codex \d+s: Stop/
  );
  expect(visibleBoard).not.toContain("agent latest");
  expect(visibleBoard).not.toContain("\n\nDelta");
  for (const line of visibleBoard
    .split("\n")
    .filter(
      (candidate) =>
        candidate.includes("claude→codex") || candidate.includes("codex→claude")
    )) {
    expect(line.length).toBeLessThanOrEqual(176);
  }
  expect(result.board).toContain("\x1b[35mclaude");
  expect(result.board).toContain("\x1b[36mcodex");
  expect(result.board).toContain("\x1b[33m30s");
});

test("board keeps warning-colored agent columns aligned", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    readUsage: (agent) =>
      usage(
        agent === "claude"
          ? {
              contextTokens: 180_000,
              contextWindow: 200_000,
              messages: 12,
              rateLimitPrimaryPct: 90,
              rateLimitSecondaryPct: 10,
              totalTokens: 180_000,
            }
          : {
              contextTokens: 10_000,
              contextWindow: 200_000,
              messages: 3,
              totalTokens: 10_000,
            }
      ),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
      ],
    }),
    deps
  );
  const visibleBoard = stripAnsi(result.board);
  const lines = visibleBoard.split("\n");
  const header = lines.find((line) => line.includes("AGENT"));
  const claude = lines.find((line) => line.startsWith(" claude"));
  const codex = lines.find((line) => line.startsWith(" codex"));
  expect(header).toBeDefined();
  expect(claude).toBeDefined();
  expect(codex).toBeDefined();
  const contextLabel = "USED/MAX";
  const contextStart =
    (header as string).indexOf(contextLabel) - (9 - contextLabel.length);
  const limitsStart = (header as string).indexOf("LIMITS");
  expect((claude as string).slice(contextStart, limitsStart).trim()).toContain(
    "180k/200k  90%  c0"
  );
  expect((codex as string).slice(contextStart, limitsStart).trim()).toContain(
    "10k/200k   5%  c0"
  );
  expect(visibleBoard).toContain("180k/200k  90%  c0");
  expect(result.board).toContain("\x1b[31m180k/200k  90%  c0");
});

test("board renders only aggregate dynamic usage tracker windows", async () => {
  const clock = { ms: Date.parse("Jan 12 2026 12:00 PM") };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    readUsage: (agent) =>
      usage({
        messages: agent === "claude" ? 12 : 8,
        rateLimitPrimaryPct: agent === "codex" ? 99 : undefined,
        rateLimitSecondaryPct: agent === "codex" ? 98 : undefined,
        totalTokens: agent === "claude" ? 120_000 : 80_000,
      }),
    readUsageLimits: () =>
      Promise.resolve({
        claude: {
          primaryPct: 43,
          primaryReset: "2:19pm",
          secondaryPct: 17,
          secondaryReset: "Jan 13 at 5:59pm",
          windows: [
            {
              kind: "session",
              label: "Session",
              reset: "2:19pm",
              scopeKind: "aggregate",
              usedPct: 43,
            },
            {
              kind: "weekly",
              label: "Weekly",
              reset: "Jan 13 at 5:59pm",
              scopeKind: "aggregate",
              usedPct: 17,
            },
          ],
        },
        codex: {
          secondaryPct: 31,
          secondaryReset: "Jan 13 6:46 PM",
          windows: [
            {
              kind: "weekly",
              label: "Weekly",
              resetAtMs: Date.parse("Jan 13 2026 6:46 PM"),
              scopeKind: "aggregate",
              usedPct: 31,
            },
          ],
        },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
      ],
    }),
    deps
  );
  const visibleBoard = stripAnsi(result.board);

  expect(visibleBoard).toMatch(/LIMITS\s+RESET/);
  expect(visibleBoard).toMatch(/S43\/W17\s+2h19m\/29h59m/);
  expect(visibleBoard).toMatch(/W31\s+30h46m/);
  const quotaRows = visibleBoard.split("\n");
  const claudeQuotaRow = quotaRows.find((line) => line.startsWith(" claude"));
  const codexQuotaRow = quotaRows.find((line) => line.startsWith(" codex"));
  expect(claudeQuotaRow?.indexOf("W17")).toBe(codexQuotaRow?.indexOf("W31"));
  expect(visibleBoard).not.toContain("S12.5");
  expect(visibleBoard).toContain("30h46m");
  expect(visibleBoard).not.toContain("2:19p");
  expect(visibleBoard).not.toContain("12:00p");
  expect(visibleBoard).not.toContain("Jan 12 2:19p");
  expect(visibleBoard).not.toContain("Jan 12 12:00p");
  expect(visibleBoard).not.toContain("S99/W98");
});

test("board shows input, cached, and output token details", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    readLocalLlmRuntime: () => ({
      cachedPromptTokens: 13_442,
      decodeConcurrency: 32,
      kvCacheGb: 0.36,
      kvCacheSequences: 10,
      modelInfo: {
        attentionHeads: 16,
        contextTokens: 262_144,
        dtype: "bfloat16",
        fullAttentionInterval: 4,
        headDim: 256,
        hiddenSize: 2048,
        kvHeads: 2,
        layers: 40,
        moeActiveExperts: 8,
        moeExperts: 256,
        quantBits: 4,
        quantGroupSize: 64,
        quantMode: "affine",
      },
      prefillStepSize: 2048,
      promptCacheGb: 1.46,
      promptCacheMaxSequences: 10,
      promptCacheRoles: {
        assistant: 0.68,
        system: 0.27,
        user: 0.51,
      },
      promptCacheSequences: 10,
      promptConcurrency: 8,
      promptTokens: 65_613,
    }),
    readUsage: () => ({
      cacheCreateTokens: 600,
      cacheReadTokens: 3400,
      compactedContextTokens: 1_000_000,
      compactions: 2,
      contextRateTokensPerMinute: 1000,
      contextTokens: 120_000,
      contextWindow: 200_000,
      costRateUsdPerHour: 42,
      creditCostMultiplier: 2.5,
      costUsd: 12,
      dataConfidence: "approx",
      humanMessages: 0,
      inputTokens: 1200,
      lastCompactionTs: new Date(START_MS - 10 * 60_000).toISOString(),
      messages: 0,
      model: "gpt-5.5",
      outputTokens: 7800,
      rateLimitPrimaryPct: 70,
      rateLimitSecondaryPct: 24,
      reasoningEffort: "medium",
      serviceTier: "fast",
      speed: "fast",
      textMessages: 12,
      thinkingMessages: 3,
      toolCalls: 4,
      toolCallCounts: {
        apply_patch: 1,
        exec_command: 3,
      },
      totalTokens: 13_000,
    }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
      ],
      cavemanMode: "full",
      helperCavemanMode: "ultra",
    }),
    deps,
    {
      ...freshRunState(),
      llmTokens: 1000,
      llmUsage: {
        cachedInputTokens: 500,
        calls: 3,
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 2000,
      },
    }
  );
  const visibleBoard = stripAnsi(result.board);

  expect(visibleBoard).toMatch(
    /AGENT\s+STATE\s+AGE\s+MODEL\s+EFF\s+MODE\s+X\s+USED\/MAX\s+PCT\s+CMP\s+LIMITS\s+RESET\s+COST\s+RATE\s+TOTAL\s+INPUT\s+CACHE\s+OUTPUT\s+TEXT\s+THINK\s+TOOL\s+HUMAN\/BRIDGE/
  );
  expect(visibleBoard.match(/^ AGENT/gm) ?? []).toHaveLength(1);
  expect(visibleBoard.match(/^ claude/gm) ?? []).toHaveLength(1);
  expect(visibleBoard.match(/^ codex/gm) ?? []).toHaveLength(1);
  expect(visibleBoard).not.toContain("LAST");
  expect(visibleBoard).not.toContain("OTHER");
  expect(visibleBoard).toMatch(/TEXT\s+THINK\s+TOOL/);
  expect(visibleBoard).toContain("med");
  expect(visibleBoard).toMatch(/fast\s+2\.5x/);
  expect(visibleBoard).toMatch(/TOTAL\s+INPUT\s+CACHE\s+OUTPUT/);
  expect(visibleBoard).toMatch(/USED\/MAX\s+PCT\s+CMP/);
  expect(visibleBoard).toContain("CMP");
  expect(visibleBoard).not.toContain("C/M");
  expect(visibleBoard).not.toContain("T85");
  expect(visibleBoard).not.toContain("IDLE");
  expect(visibleBoard).not.toContain("WORK");
  expect(visibleBoard).toMatch(/COST\s+RATE/);
  expect(visibleBoard).toMatch(/LIMITS\s+RESET/);
  expect(visibleBoard).toMatch(/^ claude.*\s12\s+3\s+4\s/m);
  const boardLines = visibleBoard.split("\n");
  const agentHeader = boardLines.find((line) => line.startsWith(" AGENT"));
  const agentRows = boardLines.filter(
    (line) => line.startsWith(" claude") || line.startsWith(" codex")
  );
  expect(agentHeader?.length).toBeLessThanOrEqual(176);
  expect(agentRows).toHaveLength(2);
  const claudeRow = agentRows.find((line) => line.startsWith(" claude"));
  for (const [label, value, width] of [
    ["TOTAL", "13k", 5],
    ["INPUT", "1k", 5],
    ["CACHE", "4k", 5],
    ["OUTPUT", "8k", 6],
    ["TEXT", "12", 5],
    ["THINK", "3", 5],
    ["TOOL", "4", 4],
  ] as const) {
    const start = agentHeader?.indexOf(label) ?? -1;
    expect(start).toBeGreaterThan(0);
    expect(claudeRow?.slice(start, start + width).trim()).toBe(value);
  }
  for (const row of agentRows) {
    expect(row.length).toBeLessThanOrEqual(176);
    expect(row).not.toContain("…");
  }
  expect(visibleBoard).toContain("joint idle 0s");
  expect(visibleBoard).not.toContain("msgs claude 0 codex 0");
  expect(visibleBoard).toContain(
    "nanny model · m · ok · 3 calls · 2k tok (i900 c500 o100) · cache 20% · slots 10/10 · mem 1.82GB"
  );
  expect(visibleBoard).toContain("@0d95a81 · 40L h2048 ctx262k");
  expect(visibleBoard).toContain(
    "runtime · caveman main full / helpers ultra @0d95a81"
  );
  expect(visibleBoard).toContain("bf16 q4/g64");
  expect(visibleBoard).toContain("MoE 256e/8");
  expect(visibleBoard).toContain("batch 8/32 · step 2048");
  const llmLines = boardLines.filter(
    (line) => line.startsWith(" nanny model") || line.startsWith(" runtime")
  );
  expect(llmLines.every((line) => line.length <= 176)).toBe(true);
  expect(visibleBoard).toContain("temp 0");
  expect(visibleBoard).toContain("max out 1.2k judge+wait / 3.2k summary");
  expect(visibleBoard).not.toContain("idle-both");
  expect(visibleBoard).not.toContain("recov 0");
  expect(visibleBoard).not.toContain("qwen");
  expect(visibleBoard).not.toContain("codex:claude");
  expect(visibleBoard).not.toContain("DATA");
  expect(visibleBoard).not.toContain("CAGE");
  expect(visibleBoard).toContain("$42");
  expect(visibleBoard).toContain("S70/W24");
  expect(visibleBoard).toMatch(/claude\s+● thinking\s+(—|0s)\s+gpt-5\.5/);
  expect(visibleBoard).toMatch(/S70\/W24\s+—\/—/);
  expect(visibleBoard).toContain("Σ est $24.00");
  expect(visibleBoard).toMatch(/\$12\.00\s+\$42\s+13k\s+1k\s+4k\s+8k/);
  expect(result.board).toContain("\x1b[36mm");
  expect(result.board).toContain("\x1b[33m2k");
  expect(result.board).toContain("\x1b[35mbf16");
});

test("board uses only Progress and Next from the structured summary", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const summary = [
    "Project: hidden project",
    "Objective: hidden objective",
    "Progress: hidden progress",
    "Next: hidden next",
  ].join("\n");
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({ viewportRows: 7 }),
    makeDeps(working, clock, spies),
    { ...freshRunState(), summary }
  );
  const board = stripAnsi(result.board);
  expect(board).not.toContain("Project:");
  expect(board).not.toContain("Objective:");
  expect(board).toContain("Progress: hidden progress");
  expect(board).toContain("Next: hidden next");
  expect(board.split("\n").slice(-2)).toEqual([
    " Progress: hidden progress",
    " Next: hidden next",
  ]);
});

test("board uses the recovered summary area for Nanny and Au Pair metrics", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "governess-utility-board-"));
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["return source-backed evidence"],
      authority: {},
      createdAt: "2026-07-26T01:00:00.000Z",
      id: "board-job",
      kind: "inspect",
      objective: "Inspect the active worker configuration",
      contextRefs: ["docs/worker.md"],
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, request);
    activateUtilityEpoch(runDir, 1);
    transitionUtilityJob(runDir, request.id, "routed-utility", {
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-au-pair",
      },
      routeEpoch: 1,
    });
    claimUtilityJob(runDir, 1, {
      jobId: request.id,
      workerId: "test",
      workerPid: process.pid,
    });
    transitionUtilityJob(runDir, request.id, "running");
    transitionUtilityJob(runDir, request.id, "completed", {
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "Found the active worker configuration in utility-runtime.ts.",
      },
    });
    appendNativeFallbackRequest(
      runDir,
      createNativeFallbackRequest({
        acceptanceCriteria: ["return independent file-backed findings"],
        evidenceTaskIds: [request.id],
        fallbackReason: "independent-review",
        id: "board-native-fallback",
        kind: "review",
        objective: "Independently review the bounded worker configuration",
        readScope: ["src/loop"],
        requester: "claude",
      })
    );
    processPendingNativeFallbackRequests({
      epoch: 1,
      mode: "utility-first",
      nowMs: START_MS,
      runDir,
    });
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      `${JSON.stringify({
        contextSha256: "b".repeat(64),
        contextVersion: 1,
        durationMs: 12_000,
        jobId: request.id,
        model: "z-ai/glm-5.2",
        modelCalls: 4,
        status: "completed",
        toolCalls: 3,
        usage: {
          cachedInputTokens: 2000,
          cost: 0.0123,
          inputTokens: 5000,
          outputTokens: 1500,
          totalTokens: 6500,
        },
      })}\n`
    );
    const latestFailed = createUtilityRouteRequest({
      acceptanceCriteria: ["show the failure"],
      authority: {},
      createdAt: "2099-01-01T00:00:00.000Z",
      id: "latest-failure",
      kind: "inspect",
      objective: "Inspect one later bounded task",
      readScope: ["src"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, latestFailed);
    transitionUtilityJob(runDir, latestFailed.id, "routed-utility", {
      at: "2099-01-01T00:00:00.100Z",
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-au-pair",
      },
      routeEpoch: 1,
    });
    transitionUtilityJob(runDir, latestFailed.id, "failed", {
      at: "2099-01-01T00:00:01.000Z",
      result: {
        artifactRefs: [],
        blocker: "bounded failure",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Failed closed.",
      },
    });
    writeFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${JSON.stringify({
        at: "2099-01-01T00:00:00.500Z",
        durationMs: 4,
        error: { code: "broker_invalid_arguments" },
        jobId: latestFailed.id,
        ok: false,
        tool: "search",
      })}\n`
    );
    const skipped = createUtilityRouteRequest({
      acceptanceCriteria: ["stay with the driver"],
      authority: {},
      createdAt: "2026-07-26T00:59:00.000Z",
      id: "skipped-route",
      kind: "inspect",
      objective: "Inspect a protected governing file",
      readScope: ["AGENTS.md"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, skipped);
    transitionUtilityJob(runDir, skipped.id, "routed-driver", {
      decision: { reason: "protected-scope", target: "driver" },
    });
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "a".repeat(64),
        operation: "source-slice",
        reason: "source-slice",
        source: "claude-hook",
        taskId: request.id,
      })
    );
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "codex",
        disposition: "explicit-routed",
        fingerprint: "b".repeat(64),
        operation: "inspect",
        reason: "explicit-tool-request",
        source: "bridge",
        taskId: latestFailed.id,
      })
    );
    const result = await governessTick(
      new Map<Agent, AgentLivenessState>(),
      baseConfig({ runDir }),
      makeDeps(working, clock, spies),
      { ...freshRunState(), summary: "Project: must remain hidden" }
    );
    const board = stripAnsi(result.board);

    expect(board.match(/^ AGENT/gm) ?? []).toHaveLength(1);
    expect(board.match(/^ HELPER/gm) ?? []).toHaveLength(1);
    expect(board).not.toContain("LOWER");
    expect(board).toMatch(
      /au pair\s+● idle\s+—\s+glm-5\.2\s+1\s+1\s+0\s+0\s+0\s+\$0\.0123\s+7k\s+5k\s+2k\s+2k\s+4\s+3/
    );
    const boardLines = board.split("\n");
    const agentHeader = boardLines.find((line) => line.startsWith(" AGENT"));
    const helperHeader = boardLines.find((line) => line.startsWith(" HELPER"));
    expect(agentHeader?.indexOf("TOTAL")).toBe(helperHeader?.indexOf("TOTAL"));
    expect((agentHeader?.indexOf("TEXT") ?? -1) + "TEXT".length).toBe(
      (helperHeader?.indexOf("CALLS") ?? -1) + "CALLS".length
    );
    const auPairRow = board
      .split("\n")
      .find((line) => line.startsWith(" au pair"));
    const totalStart = helperHeader?.indexOf("TOTAL") ?? -1;
    const inputStart = helperHeader?.indexOf("INPUT") ?? -1;
    const cacheStart = helperHeader?.indexOf("CACHE") ?? -1;
    const outputStart = helperHeader?.indexOf("OUTPUT") ?? -1;
    expect(totalStart).toBeGreaterThan(0);
    expect(auPairRow?.slice(totalStart, totalStart + 5).trim()).toBe("7k");
    expect(auPairRow?.slice(inputStart, inputStart + 5).trim()).toBe("5k");
    expect(auPairRow?.slice(cacheStart, cacheStart + 5).trim()).toBe("2k");
    expect(auPairRow?.slice(outputStart, outputStart + 6).trim()).toBe("2k");
    expect(auPairRow?.length).toBeLessThanOrEqual(176);
    expect(board.split("\n").every((line) => line.length <= 176)).toBe(true);
    expect(board).toContain(
      "routing · 2/3 helpers 67% · active 0 queued 0 · actionable 0 · kept 0 · unsafe 1 · auto 1 explicit 1 · packets 1 plans 0"
    );
    expect(board).not.toContain("helper jobs");
    expect(board).toContain("why · protected 1");
    expect(board).toContain(
      "helpers · 1/2 success 50% · 12s avg · $0.0123/job · 7k tok/job · 3.0 tools/job · cache 40% · bridge 2→2 pending 0"
    );
    expect(board).toContain(
      "context · 1/2 capsules 50% · refs 1 · latest v1 bbbbbbbb · misses 0 · tool failures 1 · top broker invalid arguments 1"
    );
    expect(board).toContain(
      "native · mode utility-first · slot granted 1/1 · requests 1 grants 1 done 0 · denied 0 expired 0 blocked 0 · latest independent review"
    );
    expect(board).not.toContain("Project: must remain hidden");
    expect(board).not.toContain("docs/worker.md");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("small governess viewports retain both agents, Nanny, and Au Pair", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "governess-utility-viewport-"));
  const clock = { ms: START_MS };
  const spies = freshSpies();
  try {
    const result = await governessTick(
      new Map<Agent, AgentLivenessState>(),
      baseConfig({
        agents: [
          { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
          { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
        ],
        runDir,
        viewportRows: 5,
      }),
      makeDeps(
        {
          ok: true,
          verdict: { confidence: 0.9, state: "working", summary: "" },
        },
        clock,
        spies
      )
    );
    const lines = stripAnsi(result.board).split("\n");

    expect(lines).toHaveLength(5);
    expect(lines.some((line) => line.startsWith(" claude"))).toBe(true);
    expect(lines.some((line) => line.startsWith(" codex"))).toBe(true);
    expect(lines.some((line) => line.startsWith(" nanny"))).toBe(true);
    expect(lines.some((line) => line.startsWith(" au pair"))).toBe(true);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("viewportRows=5 keeps the Direct row when the direct tier holds the run's work", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "governess-direct-viewport-"));
  const clock = { ms: START_MS };
  const spies = freshSpies();
  try {
    // Run-108 shape: the direct lane executed the work while nanny stayed
    // idle. The board must not hide the busy tier just because it renders
    // last (T-07 release blocker: entityRows tail-slice at maxRows-1).
    activateUtilityEpoch(runDir, 3);
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["report evidence"],
        authority: {},
        id: "direct-work",
        kind: "inspect",
        objective: "Inspect one bounded source file directly",
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
    transitionUtilityJob(runDir, "direct-work", "routed-utility", {
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-direct",
      },
      routeEpoch: 3,
    });
    claimUtilityJob(runDir, 3, {
      jobId: "direct-work",
      workerId: "direct-viewport-test",
      workerPid: process.pid,
    });
    transitionUtilityJob(runDir, "direct-work", "running");
    transitionUtilityJob(runDir, "direct-work", "completed", {
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "direct-work finished",
      },
    });

    const result = await governessTick(
      new Map<Agent, AgentLivenessState>(),
      baseConfig({
        agents: [
          { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
          { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
        ],
        runDir,
        viewportRows: 5,
      }),
      makeDeps(
        {
          ok: true,
          verdict: { confidence: 0.9, state: "working", summary: "" },
        },
        clock,
        spies
      )
    );
    const lines = stripAnsi(result.board).split("\n");

    expect(lines).toHaveLength(5);
    expect(lines.some((line) => line.startsWith(" claude"))).toBe(true);
    expect(lines.some((line) => line.startsWith(" codex"))).toBe(true);
    const directRow = lines.find((line) => line.startsWith(" direct"));
    expect(directRow).toBeDefined();
    // The rendered row carries the executed job count, not a blank tier.
    expect(directRow).toMatch(/\s1\s+0\s/);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("Au Pair row hides the internal routed-utility state name", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "governess-worker-routed-"));
  const clock = { ms: START_MS };
  const spies = freshSpies();
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["inspect"],
      authority: {},
      id: "routed-job",
      kind: "inspect",
      objective: "Inspect one bounded file",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, request);
    activateUtilityEpoch(runDir, 1);
    transitionUtilityJob(runDir, request.id, "routed-utility", {
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-au-pair",
      },
      routeEpoch: 1,
    });
    const result = await governessTick(
      new Map<Agent, AgentLivenessState>(),
      baseConfig({ runDir }),
      makeDeps(
        {
          ok: true,
          verdict: { confidence: 0.9, state: "working", summary: "" },
        },
        clock,
        spies
      )
    );
    const board = stripAnsi(result.board);
    expect(board).toMatch(/au pair\s+● queued.*\s0\s+0\s/);
    expect(board).toContain("bridge 1→0 pending 0");
    expect(board).not.toContain("routed-j");
    expect(board).not.toContain("routed-utility");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("observed progress clears the agent's recovery history", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies);
  const states = new Map<Agent, AgentLivenessState>();
  const seeded: RecoveryHistoryEntry[] = [
    {
      agent: "claude",
      level: "answer-prompt",
      ts: new Date(START_MS).toISOString(),
    },
  ];
  // First tick: agent is not yet suspect (pane just seen) => progress path.
  const result = await governessTick(states, baseConfig(), deps, {
    ...freshRunState(),
    history: seeded,
  });
  expect(result.runState.history).toHaveLength(0);
  expect(spies.judged).toBe(0);
});

const waitingHuman: JudgeOutcome = {
  ok: true,
  verdict: {
    confidence: 0.9,
    state: "waiting-human",
    summary: "asked the user a question",
  },
};

test("a cleanly-ended turn stays idle and is never judged, even past the idle window", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  // Last hook event is Stop => the agent finished its turn and is idle.
  const stop: HookEvent = {
    event: "Stop",
    ts: new Date(START_MS).toISOString(),
  };
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    readHooks: () => [stop],
  };
  const result = await runToSuspect(baseConfig(), deps, clock);
  expect(spies.judged).toBe(0); // idle-done agents are not sent to the judge
  expect(result.board).toContain("idle");
  expect(result.board).not.toContain("waits you");
});

test("board flags an agent that is waiting for the human", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(waitingHuman, clock, spies);
  const result = await runToSuspect(baseConfig(), deps, clock);
  expect(result.board).toContain("waits you");
});

test("board labels a session-limit pane as limited, not waiting for the human", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(waitingHuman, clock, spies),
    capturePane: () =>
      "You've hit your session limit · resets 8:50pm (America/Los_Angeles)",
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(states, baseConfig(), deps);

  expect(spies.judged).toBe(0);
  expect(result.board).toContain("limit");
  expect(result.board).not.toContain("waits you");
});

test("board does not treat an available usage-limit reset as a blocked agent", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies, {
    pane: "• You have 1 usage limit reset\navailable. Run /usage to use one.\n\n›",
  });
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig(),
    deps
  );

  expect(stripAnsi(result.board)).not.toContain("● limit");
});

test("board does not label governess limit handoff text as a session limit", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(waitingHuman, clock, spies),
    capturePane: () =>
      "❯ governess: Codex is at/near session limit. Claude is now the driver.",
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(states, baseConfig(), deps);

  expect(result.board).not.toContain("● limit");
});

test("board does not label Codex context compaction as a usage limit", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...makeDeps(waitingHuman, clock, spies),
    capturePane: () =>
      "Context window is nearly full. Compacting will run soon.\nctx: 15%",
    readUsage: () =>
      usage({
        contextTokens: 221_000,
        contextWindow: 258_000,
        messages: 418,
        totalTokens: 61_300_000,
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig({
      agents: [{ agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" }],
    }),
    deps
  );
  const codexRow = stripAnsi(result.board)
    .split("\n")
    .find((line) => line.startsWith(" codex"));

  expect(codexRow).toBeDefined();
  expect(codexRow).not.toContain("● limit");
  expect(codexRow).toContain("● thinking");
});

const twoAgents = [
  { agent: "claude" as Agent, hookFile: "claude.jsonl", pane: "s:0.0" },
  { agent: "codex" as Agent, hookFile: "codex.jsonl", pane: "s:0.1" },
];

const bothIdle = (clock: { ms: number }, spies: Spies): GovernessDeps => {
  const stop: HookEvent = {
    event: "Stop",
    ts: new Date(START_MS).toISOString(),
  };
  return { ...makeDeps(stuck, clock, spies), readHooks: () => [stop] };
};

test("a confirmed waiting pair clears the moment an agent goes active", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  let frame = 0;
  const stop: HookEvent = {
    event: "Stop",
    ts: new Date(START_MS).toISOString(),
  };
  const deps: GovernessDeps = {
    ...makeDeps(stuck, clock, spies),
    // claude's pane animates (thinking); codex ended its turn (idle).
    capturePane: (pane) => (pane.endsWith(".0") ? `frame ${frame++}` : "idle"),
    readHooks: (file) => (file.includes("codex") ? [stop] : []),
  };
  const config = baseConfig({ agents: twoAgents });
  const states = new Map<Agent, AgentLivenessState>();
  // Seed a confirmed waiting read; claude is active this tick, so it must clear.
  const result = await governessTick(states, config, deps, {
    ...freshRunState(),
    bothIdleSince: START_MS,
    waitingAsk: "merge?",
    waitingConfirmed: true,
  });
  expect(result.board).not.toContain("waiting for you");
  expect(result.runState.waitingConfirmed).toBe(false);
});

test("a confirmed idle pair shows the LLM's ask and escalates once", async () => {
  const clock = { ms: START_MS + 400_000 }; // well past escalateIdleMs
  const spies = freshSpies();
  const deps = bothIdle(clock, spies);
  const config = baseConfig({ agents: twoAgents });
  const states = new Map<Agent, AgentLivenessState>();
  const seeded = {
    ...freshRunState(),
    bothIdleSince: START_MS,
    waitingAsk: "Should I merge this now?",
    waitingConfirmed: true,
  };
  const t1 = await governessTick(states, config, deps, seeded);
  expect(t1.board).toContain("waiting for you");
  expect(t1.board).toContain("Should I merge this now?");
  // A second tick must not re-escalate (deduped).
  await governessTick(states, config, deps, t1.runState);
  const waits = spies.notifies.filter((e) => e.kind === "waiting-human");
  expect(waits).toHaveLength(1);
  expect(waits[0].message).toContain("Should I merge this now?");
});

test("both idle but unconfirmed by the LLM does not alert", async () => {
  const clock = { ms: START_MS + 400_000 };
  const spies = freshSpies();
  const deps = bothIdle(clock, spies);
  const config = baseConfig({ agents: twoAgents });
  const states = new Map<Agent, AgentLivenessState>();
  // Idle a long time, but the LLM has not confirmed they need us.
  const result = await governessTick(states, config, deps, {
    ...freshRunState(),
    bothIdleSince: START_MS,
  });
  expect(result.board).not.toContain("waiting for you");
  expect(spies.notifies).toHaveLength(0);
});

test("escalates once when the session crosses its cost budget", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: GovernessDeps = {
    ...makeDeps(working, clock, spies),
    readUsage: () => ({
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      compactedContextTokens: 0,
      compactions: 0,
      contextRateTokensPerMinute: 0,
      contextTokens: 0,
      contextWindow: 200_000,
      costRateUsdPerHour: 0,
      costUsd: 60,
      dataConfidence: "exact",
      humanMessages: 0,
      inputTokens: 0,
      messages: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
  };
  const config = baseConfig({ budgetUsd: 50 });
  const states = new Map<Agent, AgentLivenessState>();
  const first = await governessTick(states, config, deps);
  await governessTick(states, config, deps, first.runState);
  const budgetAlerts = spies.notifies.filter((e) => e.kind === "budget");
  expect(budgetAlerts).toHaveLength(1);
  expect(first.board).toContain("⛔");
});

test("composePaneTitle composes glyph, agent, and task label", () => {
  expect(composePaneTitle("claude", "waiting-human", "auth refactor")).toBe(
    "⏸ claude · auth refactor"
  );
  expect(composePaneTitle("codex", "working")).toBe("▶ codex");
  // Unknown state falls back to the idle glyph.
  expect(composePaneTitle("codex", "mystery")).toBe("· codex");
});

test("governess run identity includes full loop name and path", () => {
  const config = baseConfig({
    cwd: "/Users/amgad/harvto",
    runId: "34",
    session: "harvto-loop-34",
  });
  expect(composeGovernessRunIdentity(config)).toBe(
    "harvto-loop-34 · /Users/amgad/harvto"
  );
  expect(composeGovernessPaneTitle(config)).toBe("governess.harvto-loop-34");
});

test("board merges loop and path into the first time/status line", async () => {
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig({
      cwd: "/Users/amgad/harvto",
      runId: "34",
      session: "harvto-loop-34",
    }),
    makeDeps(stuck, { ms: START_MS }, freshSpies())
  );
  const lines = stripAnsi(result.board).split("\n");
  expect(lines[0]).toStartWith(
    "harvto-loop-34 · /Users/amgad/harvto · 00:16:40"
  );
  expect(lines[0]).not.toContain("governess");
  expect(lines[0]).not.toContain("run 34");
  expect(lines[1]).toStartWith(" AGENT");
});

test("governess pane identity is reapplied without deduplication", () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  const config = baseConfig({
    cwd: "/Users/amgad/harvto",
    runId: "34",
    session: "harvto-loop-34",
  });
  applyGovernessPaneIdentity(config, deps, "%9");
  applyGovernessPaneIdentity(config, deps, "%9");
  expect(spies.governessPaneIdentities).toEqual([
    ["%9", "governess.harvto-loop-34"],
    ["%9", "governess.harvto-loop-34"],
  ]);
  expect(spies.paneLabels).toEqual([]);
});

test("governess pane identity writes the border option and native title", () => {
  const label = "governess.harvto-loop-34";
  const handle = createManifestHandle({
    manifestPath: "/tmp/run/manifest.json",
    manifestSha256: "a".repeat(64),
    panes: { tmuxPaneGoverness: "%9" },
    runId: "34",
    session: "harvto-loop-34",
    socket: "/tmp/governess.sock",
  });
  const target = paneTargetFromManifest(handle, "tmuxPaneGoverness");
  if (!target) {
    throw new Error("expected a Governess pane target");
  }
  expect(governessPaneIdentityTmuxCommands(target, label)).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/governess.sock",
      "set-option",
      "-t",
      "%9",
      "-p",
      "@loop_label",
      label,
    ],
    [
      "tmux",
      "-S",
      "/tmp/governess.sock",
      "select-pane",
      "-t",
      "%9",
      "-T",
      label,
    ],
  ]);
});

test("default Governess tmux controls stay on the manifest-owned server", () => {
  const handle = createManifestHandle({
    manifestPath: "/tmp/run/manifest.json",
    manifestSha256: "a".repeat(64),
    panes: {
      tmuxPaneGoverness: "%9",
      tmuxPaneLeft: "%1",
      tmuxPaneRight: "%2",
    },
    runId: "34",
    session: "harvto-loop-34",
    socket: "/tmp/governess.sock",
  });
  const calls: string[][] = [];
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => handle,
      run: ((argv: string[]) => {
        calls.push(argv);
        const command = argv[3];
        let stdout = "";
        if (command === "capture-pane") {
          stdout = "pane text";
        } else if (command === "display-message") {
          stdout = "0:node";
        } else if (command === "list-panes") {
          stdout = "0:a\n0:b\n0:c\n";
        }
        return {
          exitCode: 0,
          signalCode: null,
          stderr: Buffer.from(""),
          stdout: Buffer.from(stdout),
        };
      }) as never,
    }
  );

  expect(deps.capturePane("%1", true)).toBe("pane text");
  expect(deps.paneCommand?.("%1")).toBe("0:node");
  expect(
    deps.readPaneCommands?.([
      { agent: "claude", pane: "%1" },
      { agent: "codex", pane: "%2" },
    ])
  ).toEqual({ claude: "0:node", codex: "0:node" });
  deps.initPaneBorders("harvto-loop-34");
  deps.respawnPane("%1");
  deps.setPaneLabel("%1", "Claude");
  deps.setGovernessPaneIdentity("%9", "Governess");
  deps.sendKeys("%1", ["Enter"]);
  deps.sendText("%2", "hello");
  deps.killSession?.("harvto-loop-34");
  expect(
    deps.replacementSessionReady("harvto-loop-34", "/tmp/run/manifest.json")
  ).toBe(true);

  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((argv) => argv[0] === "tmux")).toBe(true);
  expect(calls.every((argv) => argv[1] === "-S")).toBe(true);
  expect(calls.every((argv) => argv[2] === "/tmp/governess.sock")).toBe(true);
  expect(calls).toContainEqual([
    "tmux",
    "-S",
    "/tmp/governess.sock",
    "send-keys",
    "-t",
    "%2",
    "-l",
    "--",
    "hello",
  ]);
  expect(calls).toContainEqual([
    "tmux",
    "-S",
    "/tmp/governess.sock",
    "kill-session",
    "-t",
    "harvto-loop-34",
  ]);
});

test.each([
  ["missing", undefined],
  [
    "invalid",
    createManifestHandle({
      manifestPath: "/tmp/run/manifest.json",
      manifestSha256: "a".repeat(64),
      panes: { tmuxPaneLeft: "%1" },
      runId: "34",
      session: "harvto-loop-34",
      socket: "relative.sock",
    }),
  ],
  [
    "conflicting",
    createManifestHandle({
      manifestPath: "/tmp/run/manifest.json",
      manifestSha256: "a".repeat(64),
      panes: { tmuxPaneLeft: "%1" },
      runId: "34",
      session: "harvto-loop-34",
      socket: "/tmp/governess.sock",
      socketConflict: true,
    }),
  ],
  [
    "unrecorded pane",
    createManifestHandle({
      manifestPath: "/tmp/run/manifest.json",
      manifestSha256: "a".repeat(64),
      panes: { tmuxPaneLeft: "%2" },
      runId: "34",
      session: "harvto-loop-34",
      socket: "/tmp/governess.sock",
    }),
  ],
] as const)("default Governess rejects a %s target before tmux contact", (_label, handle) => {
  const calls: string[][] = [];
  const skips = createTmuxSkipSink();
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => handle,
      run: ((argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      }) as never,
      skipSink: skips,
    }
  );
  expect(() => deps.capturePane("%1")).toThrow();
  expect(calls).toEqual([]);
  const manifestTarget = handle ? targetFromManifest(handle) : undefined;
  expect(skips.records).toEqual([
    {
      consumer: "governess-runtime",
      effectSkipped: "capture-pane",
      pane: "%1",
      reason: manifestTarget
        ? "pane is not owned by the manifest target"
        : "manifest target is unavailable",
      runId: handle?.runId ?? "run",
      session: manifestTarget
        ? describeTmuxTarget(manifestTarget).session
        : null,
      socketState: handle ? manifestSocketState(handle) : "missing",
    },
  ]);
});

test("every unavailable default Governess tmux surface records its skipped effect", () => {
  const cases: [string, (deps: GovernessDeps) => unknown][] = [
    ["capture-pane", (deps) => deps.capturePane("%1")],
    ["initialize-pane-borders", (deps) => deps.initPaneBorders("run-loop")],
    ["kill-session", (deps) => deps.killSession?.("run-loop")],
    ["display-pane-command", (deps) => deps.paneCommand?.("%1")],
    [
      "read-pane-command",
      (deps) => deps.readPaneCommands?.([{ agent: "claude", pane: "%1" }]),
    ],
    [
      "check-replacement-readiness",
      (deps) =>
        deps.replacementSessionReady("run-loop", "/tmp/run/manifest.json"),
    ],
    ["respawn-pane", (deps) => deps.respawnPane("%1")],
    ["set-pane-label", (deps) => deps.setPaneLabel("%1", "Claude")],
    [
      "set-governess-pane-identity",
      (deps) => deps.setGovernessPaneIdentity("%1", "Governess"),
    ],
    ["send-keys", (deps) => deps.sendKeys("%1", ["Enter"])],
    ["send-text", (deps) => deps.sendText("%1", "hello")],
  ];

  for (const [effectSkipped, invoke] of cases) {
    const calls: string[][] = [];
    const skips = createTmuxSkipSink();
    const deps = defaultGovernessDeps(
      undefined,
      undefined,
      "/tmp/run/manifest.json",
      {
        readManifestHandle: () => undefined,
        run: ((argv: string[]) => {
          calls.push(argv);
          return { exitCode: 0 };
        }) as never,
        skipSink: skips,
      }
    );
    try {
      invoke(deps);
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxControlUnavailableError);
    }
    expect(calls, effectSkipped).toEqual([]);
    expect(skips.records, effectSkipped).toEqual([
      {
        consumer: "governess-runtime",
        effectSkipped,
        pane:
          effectSkipped.includes("session") ||
          effectSkipped === "initialize-pane-borders" ||
          effectSkipped === "check-replacement-readiness"
            ? null
            : "%1",
        reason: "manifest target is unavailable",
        runId: "run",
        session:
          effectSkipped.includes("session") ||
          effectSkipped === "initialize-pane-borders" ||
          effectSkipped === "check-replacement-readiness"
            ? "run-loop"
            : null,
        socketState: "missing",
      },
    ]);
  }
});

test("default Governess records a valid target with the wrong requested session", () => {
  const calls: string[][] = [];
  const skips = createTmuxSkipSink();
  const handle = createManifestHandle({
    manifestPath: "/tmp/run/manifest.json",
    manifestSha256: "a".repeat(64),
    runId: "34",
    session: "recorded-loop",
    socket: "/tmp/governess.sock",
  });
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => handle,
      run: ((argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      }) as never,
      skipSink: skips,
    }
  );

  expect(() => deps.killSession?.("requested-loop")).toThrow();
  expect(calls).toEqual([]);
  expect(skips.records).toEqual([
    {
      consumer: "governess-runtime",
      effectSkipped: "kill-session",
      pane: null,
      reason: "manifest target session does not match requested session",
      runId: "34",
      session: "requested-loop",
      socketState: "unknown",
    },
  ]);
});

test("compound border initialization revalidates authority before its second command", () => {
  let reads = 0;
  const calls: string[][] = [];
  const skips = createTmuxSkipSink();
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => {
        reads += 1;
        return createManifestHandle({
          manifestPath: "/tmp/run/manifest.json",
          manifestSha256: (reads === 1 ? "a" : "b").repeat(64),
          runId: "34",
          session: "run-loop",
          socket: reads === 1 ? "/tmp/server-a.sock" : "/tmp/server-b.sock",
        });
      },
      run: ((argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      }) as never,
      skipSink: skips,
    }
  );

  expect(() => deps.initPaneBorders("run-loop")).toThrow();
  expect(calls).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/server-a.sock",
      "set-option",
      "-t",
      "run-loop",
      "pane-border-status",
      "top",
    ],
  ]);
  expect(skips.records).toEqual([
    {
      consumer: "governess-runtime",
      effectSkipped: "initialize-pane-borders",
      pane: null,
      reason: "manifest target changed during compound effect",
      runId: "34",
      session: "run-loop",
      socketState: "unknown",
    },
  ]);
});

test("compound Governess pane identity revalidates authority before its second command", () => {
  let reads = 0;
  const calls: string[][] = [];
  const skips = createTmuxSkipSink();
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => {
        reads += 1;
        return createManifestHandle({
          manifestPath: "/tmp/run/manifest.json",
          manifestSha256: (reads === 1 ? "a" : "b").repeat(64),
          panes: { tmuxPaneGoverness: "%1" },
          runId: "34",
          session: "run-loop",
          socket: reads === 1 ? "/tmp/server-a.sock" : "/tmp/server-b.sock",
        });
      },
      run: ((argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      }) as never,
      skipSink: skips,
    }
  );

  expect(() => deps.setGovernessPaneIdentity("%1", "Governess")).toThrow();
  expect(calls).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/server-a.sock",
      "set-option",
      "-t",
      "%1",
      "-p",
      "@loop_label",
      "Governess",
    ],
  ]);
  expect(skips.records).toEqual([
    {
      consumer: "governess-runtime",
      effectSkipped: "set-governess-pane-identity",
      pane: "%1",
      reason: "manifest target changed during compound effect",
      runId: "34",
      session: "run-loop",
      socketState: "unknown",
    },
  ]);
});

test("replacement readiness uses the replacement manifest server", () => {
  const current = createManifestHandle({
    manifestPath: "/tmp/current/manifest.json",
    manifestSha256: "a".repeat(64),
    panes: { tmuxPaneLeft: "%1" },
    runId: "current",
    session: "current-loop",
    socket: "/tmp/current.sock",
  });
  const replacement = createManifestHandle({
    manifestPath: "/tmp/replacement/manifest.json",
    manifestSha256: "b".repeat(64),
    panes: { tmuxPaneLeft: "%9" },
    runId: "replacement",
    session: "replacement-loop",
    socket: "/tmp/replacement.sock",
  });
  const calls: string[][] = [];
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/current/manifest.json",
    {
      readManifestHandle: (path) =>
        path === "/tmp/replacement/manifest.json" ? replacement : current,
      run: ((argv: string[]) => {
        calls.push(argv);
        return {
          exitCode: 0,
          signalCode: null,
          stderr: Buffer.from(""),
          stdout: Buffer.from("0:a\n0:b\n0:c\n"),
        };
      }) as never,
    }
  );

  expect(
    deps.replacementSessionReady(
      "replacement-loop",
      "/tmp/replacement/manifest.json"
    )
  ).toBe(true);
  expect(calls).toEqual([
    [
      "tmux",
      "-S",
      "/tmp/replacement.sock",
      "list-panes",
      "-t",
      "replacement-loop",
      "-F",
      "#{pane_dead}:#{pane_current_command}",
    ],
  ]);
});

test("batched pane reads resolve every current capability before tmux contact", () => {
  const first = createManifestHandle({
    manifestPath: "/tmp/run/manifest.json",
    manifestSha256: "a".repeat(64),
    panes: { tmuxPaneLeft: "%1" },
    runId: "34",
    session: "harvto-loop-34",
    socket: "/tmp/governess.sock",
  });
  const changed = createManifestHandle({
    manifestPath: "/tmp/run/manifest.json",
    manifestSha256: "b".repeat(64),
    panes: { tmuxPaneLeft: "%1" },
    runId: "34",
    session: "harvto-loop-34",
    socket: "/tmp/changed.sock",
  });
  let reads = 0;
  const calls: string[][] = [];
  const deps = defaultGovernessDeps(
    undefined,
    undefined,
    "/tmp/run/manifest.json",
    {
      readManifestHandle: () => {
        reads += 1;
        return reads === 1 ? first : changed;
      },
      run: ((argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      }) as never,
    }
  );

  expect(() =>
    deps.readPaneCommands?.([
      { agent: "claude", pane: "%1" },
      { agent: "codex", pane: "%2" },
    ])
  ).toThrow();
  expect(calls).toEqual([]);
});

test("runGoverness applies pane identity once on startup", async () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  const keys = ["x", "e"];
  let closed = false;
  deps.openKeyInput = () => ({
    close: () => {
      closed = true;
    },
    next: () => Promise.resolve(keys.shift() ?? ""),
  });
  deps.sleep = () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
  await runGoverness(
    baseConfig({
      cwd: "/Users/amgad/harvto",
      runId: "34",
      session: "harvto-loop-34",
    }),
    deps
  );
  expect(spies.paneBorderInits).toEqual(["harvto-loop-34"]);
  expect(spies.governessPaneIdentities).toHaveLength(1);
  expect(
    new Set(spies.governessPaneIdentities.map((entry) => entry[1]))
  ).toEqual(new Set(["governess.harvto-loop-34"]));
  expect(
    spies.paneLabels.every(([pane]) => pane !== "harvto-loop-34:0.2")
  ).toBe(true);
  expect(closed).toBe(true);
});

test("runGoverness renders a degraded tick without recovery when tmux capture is unknown", async () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  let captureAttempts = 0;
  deps.capturePane = () => {
    captureAttempts += 1;
    if (captureAttempts === 1) {
      throw new TmuxControlUnavailableError([
        "capture-pane",
        "-p",
        "-t",
        "s:0.0",
      ]);
    }
    return "stable pane text";
  };
  const keys = ["x", "e"];
  deps.openKeyInput = () => ({
    close: () => undefined,
    next: () => Promise.resolve(keys.shift() ?? ""),
  });
  deps.sleep = () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5));

  await runGoverness(baseConfig(), deps);

  expect(captureAttempts).toBeGreaterThanOrEqual(2);
  expect(spies.respawns).toEqual([]);
  expect(spies.sends).toEqual([]);
  expect(spies.logs).toContainEqual({
    at: new Date(START_MS).toISOString(),
    error: "tmux control unavailable: tmux capture-pane -p -t s:0.0",
    event: "tmux-control-unavailable",
  });
});

test("governessTick stops probing after one tmux failure and recovers next tick", async () => {
  const spies = freshSpies();
  const clock = { ms: START_MS };
  const deps = makeDeps(stuck, clock, spies);
  const rendered: string[] = [];
  let unavailable = true;
  let captureAttempts = 0;
  deps.capturePane = () => {
    captureAttempts += 1;
    if (unavailable) {
      throw new TmuxControlUnavailableError([
        "capture-pane",
        "-p",
        "-t",
        "s:0.0",
      ]);
    }
    return "stable pane text";
  };
  deps.render = (board) => rendered.push(stripAnsi(board));
  const config = baseConfig({
    agents: [
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
    ],
  });
  const seeded = freshRunState();
  seeded.history = [
    { agent: "claude", level: "nudge", ts: new Date(START_MS).toISOString() },
  ];

  const degraded = await governessTick(new Map(), config, deps, seeded);

  expect(captureAttempts).toBe(1);
  expect(degraded.tmuxControlAvailable).toBe(false);
  expect(rendered.at(-1)).toContain("tmux degraded 0s (capture-pane)");
  expect(rendered.at(-1)).toContain("unknown");
  expect(degraded.runState.history).toEqual(seeded.history);
  expect(spies.judged).toBe(0);
  expect(spies.sends).toEqual([]);
  expect(spies.paneLabels).toEqual([]);
  expect(spies.logs).toContainEqual({
    at: new Date(START_MS).toISOString(),
    error: "tmux control unavailable: tmux capture-pane -p -t s:0.0",
    event: "tmux-control-unavailable",
  });

  unavailable = false;
  clock.ms += 15_000;
  const restored = await governessTick(
    degraded.states,
    config,
    deps,
    degraded.runState
  );

  expect(captureAttempts).toBe(3);
  expect(restored.tmuxControlAvailable).toBe(true);
  expect(stripAnsi(restored.board)).not.toContain("tmux degraded");
  expect(spies.logs).toContainEqual({
    at: new Date(clock.ms).toISOString(),
    event: "tmux-control-restored",
    unavailableMs: 15_000,
  });
});

test("governessTick treats one batched pane-command timeout as a degraded tick", async () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  let captures = 0;
  let commandBatches = 0;
  deps.capturePane = () => {
    captures += 1;
    return "stable pane text";
  };
  deps.readPaneCommands = () => {
    commandBatches += 1;
    throw new TmuxControlUnavailableError(["list-panes", "-a"]);
  };

  const result = await governessTick(
    new Map(),
    baseConfig({
      agents: [
        { agent: "claude", hookFile: "claude.jsonl", pane: "%0" },
        { agent: "codex", hookFile: "codex.jsonl", pane: "%1" },
      ],
    }),
    deps
  );

  expect(captures).toBe(2);
  expect(commandBatches).toBe(1);
  expect(result.tmuxControlAvailable).toBe(false);
  expect(stripAnsi(result.board)).toContain("tmux degraded 0s (list-panes)");
  expect(spies.judged).toBe(0);
  expect(spies.paneLabels).toEqual([]);
  expect(spies.sends).toEqual([]);
});

test("large Unicode pane output does not enlarge the bounded Governess board", async () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  const largePane = "🧭│─ Governess evidence 密度\n".repeat(600);
  expect(Buffer.byteLength(largePane, "utf8")).toBeGreaterThan(10_000);
  deps.capturePane = () => largePane;

  const result = await governessTick(
    new Map(),
    baseConfig({ viewportColumns: 120, viewportRows: 12 }),
    deps
  );

  expect(result.tmuxControlAvailable).toBe(true);
  expect(stripAnsi(result.board).split("\n").length).toBeLessThanOrEqual(12);
  expect(
    Math.max(
      ...stripAnsi(result.board)
        .split("\n")
        .map((line) => line.length)
    )
  ).toBeLessThanOrEqual(120);
});

test("Governess frame deltas update only changed lines without clearing", () => {
  const previous = "header\nstable\nold tail";
  const next = "header\nstable\nnew tail";
  const delta = governessFrameDelta(previous, next);

  expect(delta).toContain("\x1b[3;1H\x1b[2Knew tail");
  expect(delta).not.toContain("\x1b[2J");
  expect(delta).not.toContain("stable");
  expect(governessFrameDelta(next, next)).toBe("");
});

test("Governess restart clears stale history before drawing one live snapshot", () => {
  let history = ["│ Codex old 75k 29% $27.19"];
  let viewport = ["│ au pair old completed 4"];
  const liveFrame = [
    "│ Codex live 90k 35% $28.26",
    "│ au pair live completed 4",
  ].join("\n");
  const output = governessInitialFrame(liveFrame);

  expect(output).toStartWith("\x1b[3J\x1b[2J\x1b[H");
  if (output.includes("\x1b[3J")) {
    history = [];
  }
  if (output.includes("\x1b[2J")) {
    viewport = [];
  }
  const home = output.lastIndexOf("\x1b[H");
  viewport.push(output.slice(home + "\x1b[H".length));
  const captured = [...history, ...viewport].join("\n");
  expect(captured).not.toContain("Codex old");
  expect(captured).not.toContain("au pair old");
  expect(captured.match(/Codex /g)).toHaveLength(1);
  expect(captured.match(/au pair /g)).toHaveLength(1);
});

test("runGoverness refreshes a late Codex binding before reading usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-live-binding-"));
  const manifestPath = join(root, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexThreadId: "codex-thread-live",
      cwd: root,
      mode: "paired",
      pid: 1234,
      repoId: "repo",
      runId: "94",
      status: "running",
      tmuxPaneLeftAgent: "codex",
      tmuxSession: "repo-loop-94",
    })
  );
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  const seenSessionRefs: (string | undefined)[] = [];
  deps.readUsage = (_agent, sessionRef) => {
    seenSessionRefs.push(sessionRef);
    return usage();
  };
  const keys = ["x", "e"];
  deps.openKeyInput = () => ({
    close: () => undefined,
    next: () => Promise.resolve(keys.shift() ?? ""),
  });
  deps.sleep = () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
  const config = baseConfig({
    agents: [{ agent: "codex", hookFile: "hooks.jsonl", pane: "s:0.0" }],
    manifestPath,
  });

  try {
    await runGoverness(config, deps);
    expect(seenSessionRefs.length).toBeGreaterThan(0);
    expect(new Set(seenSessionRefs)).toEqual(new Set(["codex-thread-live"]));
    expect(config.agents[0]?.sessionRef).toBe("codex-thread-live");
    expect(spies.logs).toContainEqual({
      agent: "codex",
      at: new Date(START_MS).toISOString(),
      event: "agent-session-binding-refreshed",
      from: null,
      to: "codex-thread-live",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governessTick sets each agent's pane border title and skips redundant sets", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies);
  const config = baseConfig();
  const first = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    config,
    deps
  );
  expect(spies.paneLabels).toEqual([["s:0.0", "… claude"]]);
  // Same state on the next tick => no fresh tmux set.
  await governessTick(
    new Map<Agent, AgentLivenessState>(),
    config,
    deps,
    first.runState
  );
  expect(spies.paneLabels).toHaveLength(1);
});

test("governessTick folds the stored LLM label into the border title", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(stuck, clock, spies);
  const runState = {
    ...freshRunState(),
    paneLabels: { claude: "auth refactor" },
  };
  await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig(),
    deps,
    runState
  );
  expect(spies.paneLabels).toEqual([["s:0.0", "… claude · auth refactor"]]);
});

test("sendRenameCommands is disabled by default", () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  sendRenameCommands(baseConfig(), deps, { claude: "auth refactor" }, {});
  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toHaveLength(0);
});

test("agent rename config requires an explicit truthy environment value", () => {
  expect(agentRenameEnabledFromEnv({})).toBe(false);
  expect(agentRenameEnabledFromEnv({ LOOP_GOVERNESS_AGENT_RENAME: "0" })).toBe(
    false
  );
  expect(agentRenameEnabledFromEnv({ LOOP_GOVERNESS_AGENT_RENAME: "1" })).toBe(
    true
  );
});

test("sendRenameCommands injects /rename when explicitly enabled", () => {
  const spies = freshSpies();
  const deps = withSafeTurnEnd(makeDeps(stuck, { ms: START_MS }, spies));
  const config = baseConfig({
    agentRenameEnabled: true,
    agents: [
      { agent: "claude", hookFile: "h", pane: "s:0.0" },
      { agent: "codex", hookFile: "h", pane: "s:0.1" },
    ],
  });
  // Only claude has a task label => only claude is renamed.
  sendRenameCommands(
    config,
    deps,
    { claude: "auth refactor" },
    {},
    { claude: "idle" }
  );
  expect(spies.texts).toEqual(["/rename s · auth refactor"]);
  expect(spies.sends).toEqual([["s:0.0", "Enter"]]);
});

test("sendRenameCommands sends nothing in dry-run", () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  sendRenameCommands(
    baseConfig({ agentRenameEnabled: true, dryRun: true }),
    deps,
    { claude: "auth refactor" },
    {}
  );
  expect(spies.texts).toHaveLength(0);
  expect(spies.sends).toHaveLength(0);
});

test("sendRenameCommands does not re-send an unchanged rename", () => {
  const spies = freshSpies();
  const deps = withSafeTurnEnd(makeDeps(stuck, { ms: START_MS }, spies));
  const config = baseConfig({ agentRenameEnabled: true });
  const lastRenames: Partial<Record<Agent, string>> = {};
  // First refresh renames; a second identical refresh is a no-op.
  sendRenameCommands(
    config,
    deps,
    { claude: "session initialization" },
    lastRenames,
    { claude: "idle" }
  );
  sendRenameCommands(
    config,
    deps,
    { claude: "session initialization" },
    lastRenames,
    { claude: "idle" }
  );
  expect(spies.texts).toEqual(["/rename s · session initialization"]);
  expect(spies.sends).toEqual([["s:0.0", "Enter"]]);
  // A changed label sends again.
  sendRenameCommands(config, deps, { claude: "auth refactor" }, lastRenames, {
    claude: "idle",
  });
  expect(spies.texts).toHaveLength(2);
});

test("sendRenameCommands does not inject into an agent that is mid-turn", () => {
  const spies = freshSpies();
  const deps = withSafeTurnEnd(makeDeps(stuck, { ms: START_MS }, spies));
  const lastRenames: Partial<Record<Agent, string>> = {};
  // Agent is working => skip the send AND do not record, so it retries later.
  sendRenameCommands(
    baseConfig({ agentRenameEnabled: true }),
    deps,
    { claude: "auth refactor" },
    lastRenames,
    { claude: "working" }
  );
  expect(spies.texts).toHaveLength(0);
  expect(lastRenames).toEqual({});
  // Once idle, the same label renames.
  sendRenameCommands(
    baseConfig({ agentRenameEnabled: true }),
    deps,
    { claude: "auth refactor" },
    lastRenames,
    { claude: "idle" }
  );
  expect(spies.texts).toEqual(["/rename s · auth refactor"]);
});

test("sendRenameCommands fails closed without state and turn-end evidence", () => {
  const spies = freshSpies();
  const deps = makeDeps(stuck, { ms: START_MS }, spies);
  sendRenameCommands(
    baseConfig({ agentRenameEnabled: true }),
    deps,
    { claude: "auth refactor" },
    {}
  );
  expect(spies.texts).toEqual([]);
  expect(spies.sends).toEqual([]);
});

test("sendRenameCommands preserves a user draft after a Stop hook", () => {
  const spies = freshSpies();
  const deps: GovernessDeps = {
    ...withSafeTurnEnd(makeDeps(stuck, { ms: START_MS }, spies)),
    capturePane: () => "completed output\n\n› user's unfinished question",
  };
  sendRenameCommands(
    baseConfig({ agentRenameEnabled: true }),
    deps,
    { claude: "auth refactor" },
    {},
    { claude: "idle" }
  );
  expect(spies.texts).toEqual([]);
  expect(spies.sends).toEqual([]);
});

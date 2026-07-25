import { expect, test } from "bun:test";
import {
  type GovernessConfig,
  type GovernessDeps,
  type BridgeSendStatus,
  agentRenameEnabledFromEnv,
  governessTick,
  composePaneTitle,
  freshRunState,
  sendRenameCommands,
} from "../../src/loop/governess";
import type { EscalationEvent } from "../../src/loop/governess-notify";
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

const IDLE_MS = 60_000;
const START_MS = 1_000_000;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

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

const baseConfig = (overrides: Partial<GovernessConfig> = {}): GovernessConfig => ({
  agentRenameEnabled: false,
  agents: [{ agent: "claude", hookFile: "hooks.jsonl", pane: "s:0.0" }],
  budgetUsd: 0,
  confidence: 0.7,
  cooldownMs: 300_000,
  dryRun: false,
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
  expect(stripAnsi(result.board)).toMatch(/m\s+m\s+off/);
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
  expect(visibleBoard).toMatch(/qwen\s+qwen\s+ok\s+1\s+150\s+120\s+80\s+30/);
  expect(visibleBoard).toMatch(/gemma\s+gemma\s+ok\s+1\s+90\s+70\s+40\s+20/);
  expect(visibleBoard).toContain("● working");
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
  expect(visibleBoard).toMatch(/gemma\s+gemma\s+ok\s+1\s+120\s+100\s+12\s+20/);
  expect(visibleBoard).toContain("judge round-robin");
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
  expect(stripAnsi(result.board)).toContain(
    "roles · initial codex · current claude · paused codex"
  );
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

  expect(spies.bridgeMessages).toHaveLength(1);
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
  expect(spies.texts).toHaveLength(1);
  expect(spies.texts[0]).toContain("Hand the driver role back to Codex");
  expect(spies.sends).toEqual([["s:0.1", "Enter"]]);
  expect(result.runState.notified.limitHandoff.codex).toBeUndefined();
  expect(result.runState.roles.currentDriver).toBe("codex");
  expect(result.runState.roles.pausedAgent).toBeUndefined();
  expect(stripAnsi(result.board)).toContain(
    "roles · initial codex · current codex"
  );
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
  expect(spies.texts).toHaveLength(1);
  expect(spies.texts[0]).toContain("proactive quota balance");
  expect(spies.texts[0]).toContain("Claude is now the driver");
  expect(spies.sends).toEqual([["s:0.1", "Enter"]]);
  expect(spies.bridgeMessages).toHaveLength(1);
  expect(spies.bridgeMessages[0]).toMatchObject({
    runDir: "run-dir",
    source: "claude",
    status: "accepted",
    target: "codex",
  });
  expect(spies.bridgeMessages[0]?.message).toContain(
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
  expect(stripAnsi(result.board)).toContain(
    "roles · initial codex · current claude"
  );
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
  expect(stripAnsi(result.board)).toContain("roles · initial codex");
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
  expect(result.board).toContain("78k/200k 39%");
  expect(result.board).not.toContain("122k/200k 61%");
  expect(result.board).toContain("high");
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
            message: "Review approved, merge after one confirmation.",
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

  expect(visibleBoard).toContain("bridge latest");
  expect(visibleBoard).not.toContain("bridge msgs");
  expect(visibleBoard).toContain("human 4 →6 ←6");
  expect(visibleBoard).toContain("human 2 →6 ←6");
  expect(visibleBoard).not.toContain("human 3");
  expect(visibleBoard.match(/bridge latest/g) ?? []).toHaveLength(2);
  expect(visibleBoard).toContain(
    "claude→codex 30s ago: Review approved, merge after one confirmation."
  );
  expect(visibleBoard).toContain(
    "Review approved, merge after one confirmation. · claude 12s: Bash cd /repo && npm test"
  );
  expect(visibleBoard).toContain(
    "codex→claude 2m ago: Final proof checkpoint. Delta notes are ready."
  );
  expect(visibleBoard).toMatch(
    /Final proof checkpoint\. Delta notes are ready\. · codex \d+s: Stop/
  );
  expect(visibleBoard).not.toContain("agent latest");
  expect(visibleBoard).not.toContain("\n\nDelta");
  for (const line of visibleBoard
    .split("\n")
    .filter((candidate) => candidate.includes("bridge latest"))) {
    expect(line.length).toBeLessThanOrEqual(180);
  }
  expect(result.board).toContain("\x1b[35mclaude");
  expect(result.board).toContain("\x1b[36mcodex");
  expect(result.board).toContain("\x1b[33m30s ago");
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
  const contextStart = (header as string).indexOf("CONTEXT");
  const limitsStart = (header as string).indexOf("LIMITS");
  expect((claude as string).slice(contextStart, limitsStart).trim()).toContain(
    "180k/200k 90% c0"
  );
  expect((codex as string).slice(contextStart, limitsStart).trim()).toContain(
    "10k/200k 5% c0"
  );
  expect(visibleBoard).toContain("180k/200k 90% c0 ⚠");
  expect(result.board).toContain("\x1b[31m180k/200k 90% c0 ⚠");
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

  expect(visibleBoard).toContain("LIMITS · RESET");
  expect(visibleBoard).toContain("S43/W17");
  expect(visibleBoard).toContain("2h19m");
  expect(visibleBoard).toContain("29h59m");
  expect(visibleBoard).toContain("W31 · 30h46m");
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
    },
  );
  const visibleBoard = stripAnsi(result.board);

  expect(visibleBoard).toMatch(
    /AGENT\s+STATE\s+AGE\s+MODEL\s+RUN\s+CONTEXT · CMP\s+LIMITS · RESET\s+EST RUN \/ H\s+TOKENS I\/C\/O\s+ACT TX\/TH\/TL\s+MSGS \/ BRIDGE/
  );
  expect(visibleBoard.match(/^ AGENT/gm) ?? []).toHaveLength(1);
  expect(visibleBoard.match(/^ claude/gm) ?? []).toHaveLength(1);
  expect(visibleBoard.match(/^ codex/gm) ?? []).toHaveLength(1);
  expect(visibleBoard).not.toContain("LAST");
  expect(visibleBoard).not.toContain("OTHER");
  expect(visibleBoard).toContain("TX/TH/TL");
  expect(visibleBoard).toContain("med");
  expect(visibleBoard).toContain("fast/2.5x");
  expect(visibleBoard).toContain("TOKENS I/C/O");
  expect(visibleBoard).toContain("CONTEXT · CMP");
  expect(visibleBoard).toContain("CMP");
  expect(visibleBoard).not.toContain("C/M");
  expect(visibleBoard).not.toContain("T85");
  expect(visibleBoard).not.toContain("IDLE");
  expect(visibleBoard).not.toContain("WORK");
  expect(visibleBoard).toContain("EST RUN / H");
  expect(visibleBoard).toContain("LIMITS · RESET");
  expect(visibleBoard).toMatch(/^ claude.*19 tx12 th3 tl4/m);
  const boardLines = visibleBoard.split("\n");
  const agentHeader = boardLines.find((line) => line.startsWith(" AGENT"));
  const agentRows = boardLines.filter(
    (line) => line.startsWith(" claude") || line.startsWith(" codex")
  );
  expect(agentHeader?.length).toBeLessThanOrEqual(180);
  expect(agentRows).toHaveLength(2);
  for (const row of agentRows) {
    expect(row.length).toBeLessThanOrEqual(180);
    expect(row).not.toContain("…");
  }
  expect(visibleBoard).toContain("both idle total 0s");
  expect(visibleBoard).toMatch(
    /LLM\s+MODEL\s+STAT\s+CALLS\s+TOK\s+IN\s+CACHE\s+OUT\s+HIT\s+SLOTS\s+MEM\s+ARCH\s+DT\s+QNT\s+MOE\s+BATCH/
  );
  expect(visibleBoard).toMatch(
    /m\s+m\s+ok\s+3\s+2k\s+900\s+500\s+100\s+20%\s+10\/10\s+1\.82GB/
  );
  expect(visibleBoard).toContain("40L h2048 a16 kv2x256 ctx262k f/4");
  expect(visibleBoard).toContain("bf16");
  expect(visibleBoard).toContain("q4/g64 affine");
  expect(visibleBoard).toContain("256e/8");
  expect(visibleBoard).toContain("pre8 dec32 st2048");
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
  expect(visibleBoard).toMatch(/S70\/W24 ·/);
  expect(visibleBoard).toContain("Σ est $24.00");
  expect(visibleBoard).toMatch(/\$12\.00\/\$42\s+13k i1k c4k o8k/);
  expect(result.board).toContain("\x1b[36mm");
  expect(result.board).toContain("\x1b[33m2k");
  expect(result.board).toContain("\x1b[35mbf16");
});

test("board caps structured summary section heights", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const longText = Array.from({ length: 80 }, (_, i) => `detail${i}`).join(" ");
  const summary = [
    `Project: ${longText}`,
    `Objective: ${longText}`,
    `Progress: ${longText}`,
    `Next: ${longText}`,
  ].join("\n");
  const states = new Map<Agent, AgentLivenessState>();
  const result = await governessTick(
    states,
    baseConfig(),
    makeDeps(working, clock, spies),
    { ...freshRunState(), summary }
  );
  const lines = stripAnsi(result.board).split("\n");
  const summaryStart = lines.findIndex((line) => line.includes("Project:"));
  expect(summaryStart).toBeGreaterThanOrEqual(0);
  const sectionCounts: Record<string, number> = {};
  let current = "";
  for (const line of lines.slice(summaryStart)) {
    const label = line
      .trimStart()
      .match(/^(Project|Objective|Progress|Next):/i);
    if (label) {
      current = label[1].toLowerCase();
    }
    if (current && line.trim()) {
      sectionCounts[current] = (sectionCounts[current] ?? 0) + 1;
    }
  }

  expect(sectionCounts).toEqual({
    next: 2,
    objective: 2,
    progress: 2,
    project: 2,
  });
});

test("board uses the full summary width for the Project line", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const project =
    "Project: Harvto is a pre-seed AR hijab try-on platform using MediaPipe, Three.js, XPBD cloth simulation, deterministic video replay, source-bound frame validation, and an instrument-first workflow for measuring off-axis garment detachment.";
  const result = await governessTick(
    new Map<Agent, AgentLivenessState>(),
    baseConfig(),
    makeDeps(working, clock, spies),
    { ...freshRunState(), summary: project }
  );

  expect(stripAnsi(result.board).replace(/\s+/g, " ")).toContain(project);
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
  sendRenameCommands(
    config,
    deps,
    { claude: "auth refactor" },
    lastRenames,
    { claude: "idle" }
  );
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

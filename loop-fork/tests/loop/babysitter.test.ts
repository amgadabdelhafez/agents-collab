import { expect, test } from "bun:test";
import {
  type BabysitConfig,
  type BabysitDeps,
  babysitTick,
  freshRunState,
} from "../../src/loop/babysitter";
import type { EscalationEvent } from "../../src/loop/babysitter-notify";
import type {
  Agent,
  AgentLivenessState,
  AgentUsage,
  HookEvent,
  JudgeOutcome,
  JudgeRequest,
  RecoveryHistoryEntry,
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

const baseConfig = (overrides: Partial<BabysitConfig> = {}): BabysitConfig => ({
  agents: [{ agent: "claude", hookFile: "hooks.jsonl", pane: "s:0.0" }],
  budgetUsd: 0,
  confidence: 0.7,
  cooldownMs: 300_000,
  dryRun: false,
  escalateIdleMs: 300_000,
  idleMs: IDLE_MS,
  logFile: "babysitter.jsonl",
  llmDecodeConcurrency: 32,
  llmPrefillStepSize: 2048,
  llmPromptCacheSlots: 10,
  llmPromptConcurrency: 8,
  judgeMode: "consensus",
  maxRecoveries: 3,
  model: "m",
  runId: "1",
  session: "s",
  tickMs: 15_000,
  url: "http://127.0.0.1:8082",
  usageTrackerTimeoutMs: 1500,
  ...overrides,
});

interface Spies {
  judgeRequests: JudgeRequest[];
  judged: number;
  logs: unknown[];
  notifies: EscalationEvent[];
  respawns: string[];
  sends: string[][];
  texts: string[];
}

const makeDeps = (
  outcome: JudgeOutcome,
  clock: { ms: number },
  spies: Spies
): BabysitDeps => ({
  appendLog: (_file, record) => spies.logs.push(record),
  assessWaiting: () => Promise.resolve({ ask: "", tokens: 0, waiting: false }),
  capturePane: () => "stable pane text",
  judge: (req) => {
    spies.judged += 1;
    spies.judgeRequests.push(req);
    return Promise.resolve(outcome);
  },
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
  render: () => {
    // no-op for tests
  },
  respawnPane: (pane) => spies.respawns.push(pane),
  saveState: () => {
    // no-op for tests
  },
  sendKeys: (pane, keys) => spies.sends.push([pane, ...keys]),
  sendText: (_pane, text) => spies.texts.push(text),
  sleep: () => Promise.resolve(),
  summarize: () => Promise.resolve({ text: "", tokens: 0 }),
});

const freshSpies = (): Spies => ({
  judgeRequests: [],
  judged: 0,
  logs: [],
  notifies: [],
  respawns: [],
  sends: [],
  texts: [],
});

const stuck: JudgeOutcome = {
  ok: true,
  verdict: { confidence: 0.9, state: "stuck", summary: "stuck on build" },
};

// Drive two ticks: the first seeds detector state, the second (after the pane
// has been stable past the idle window with no events) makes the agent suspect.
const runToSuspect = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  clock: { ms: number }
) => {
  const states = new Map<Agent, AgentLivenessState>();
  const first = await babysitTick(states, config, deps);
  clock.ms = START_MS + 2 * IDLE_MS;
  return babysitTick(states, config, deps, first.runState);
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
  const deps: BabysitDeps = {
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
  expect(visibleBoard).toMatch(
    /qwen\s+qwen\s+ok\s+1\s+150\s+120\s+80\s+30/
  );
  expect(visibleBoard).toMatch(
    /gemma\s+gemma\s+ok\s+1\s+90\s+70\s+40\s+20/
  );
  expect(visibleBoard).toContain("● working");
});

test("round-robin local judge mode calls one model for that tick", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: BabysitDeps = {
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
  const deps: BabysitDeps = {
    ...makeDeps(stuck, clock, spies),
    capturePane: () => `frame ${frame++}`, // pane changes every tick
  };
  const states = new Map<Agent, AgentLivenessState>();
  await babysitTick(states, baseConfig(), deps);
  clock.ms = START_MS + 2 * IDLE_MS;
  const result = await babysitTick(states, baseConfig(), deps);
  expect(result.board).toContain("thinking");
});

test("board keeps the configured leader row first", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  let codexFrame = 0;
  const deps: BabysitDeps = {
    ...makeDeps(stuck, clock, spies),
    capturePane: (pane) =>
      pane === "s:0.1" ? `codex frame ${codexFrame++}` : "claude idle",
    readUsage: (agent) =>
      usage({
        messages: agent === "codex" ? 20 : 5,
        totalTokens: agent === "codex" ? 20_000 : 5_000,
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const config = baseConfig({
    agents: [
      { agent: "claude", hookFile: "claude.jsonl", pane: "s:0.0" },
      { agent: "codex", hookFile: "codex.jsonl", pane: "s:0.1" },
    ],
  });
  await babysitTick(states, config, deps);
  clock.ms = START_MS + config.tickMs + 1;
  const result = await babysitTick(states, config, deps);
  const visibleLines = stripAnsi(result.board).split("\n");
  const headerIndex = visibleLines.findIndex((line) => line.includes("AGENT"));

  expect(headerIndex).toBeGreaterThanOrEqual(0);
  expect(visibleLines[headerIndex + 1]).toStartWith(" claude");
  expect(visibleLines[headerIndex + 2]).toStartWith(" codex");
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
  await babysitTick(states, baseConfig(), deps); // seed
  // advance past a tick but under the idle threshold: frozen but not yet suspect
  clock.ms = START_MS + baseConfig().tickMs + 1;
  const result = await babysitTick(states, baseConfig(), deps);
  expect(result.board).toContain("idle");
});

test("board converts the agent's live remaining context % to used context", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: BabysitDeps = {
    ...makeDeps(working, clock, spies),
    capturePane: () => "Opus 4.8 | ctx: 61% | effort: high",
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await babysitTick(states, baseConfig(), deps);
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
  const deps: BabysitDeps = {
    ...makeDeps(working, clock, spies),
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
            message: "Please review PR #529 and check the skipped hunks.",
            signature: "s2",
            source: "codex",
            target: "claude",
          },
        },
      };
    },
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await babysitTick(
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
  expect(visibleBoard).toContain("bridge msgs");
  expect(visibleBoard).toContain("human 0");
  expect(visibleBoard.match(/bridge latest/g) ?? []).toHaveLength(2);
  expect(visibleBoard).toContain(
    "claude→codex 30s ago: Review approved, merge after one confirmation."
  );
  expect(visibleBoard).toContain(
    "codex→claude 2m ago: Please review PR #529 and check the skipped hunks."
  );
  expect(result.board.match(/\x1b\[35mclaude/g) ?? []).toHaveLength(4);
  expect(result.board.match(/\x1b\[36mcodex/g) ?? []).toHaveLength(4);
  expect(result.board).toContain("\x1b[33m30s ago");
});

test("board keeps warning-colored agent columns aligned", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: BabysitDeps = {
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
  const result = await babysitTick(
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
  const contextTotalStart = (header as string).indexOf("CTX+");
  const compactStart = (header as string).indexOf("CMP");
  expect((claude as string).slice(contextTotalStart, compactStart).trim()).toBe(
    "180k"
  );
  expect((codex as string).slice(contextTotalStart, compactStart).trim()).toBe(
    "10k"
  );
  expect(visibleBoard).toContain("180k/200k 90% ⚠");
  expect(result.board).toContain("\x1b[31m180k/200k 90% ⚠");
});

test("board overlays usage tracker session and weekly limits", async () => {
  const clock = { ms: Date.parse("Jan 12 2026 12:00 PM") };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: BabysitDeps = {
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
          primaryReset: "Jan 12 2:19 PM",
          secondaryPct: 17,
          secondaryReset: "Jan 13 5:59 PM",
        },
        codex: {
          primaryPct: 12.5,
          primaryReset: "Jan 12 12:00 PM",
          secondaryPct: 31,
          secondaryReset: "Jan 13 6:46 PM",
        },
      }),
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await babysitTick(
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

  expect(visibleBoard).toContain("LIMIT S/W");
  expect(visibleBoard).toContain("S RESET");
  expect(visibleBoard).toContain("W RESET");
  expect(visibleBoard).toContain("43s/17w");
  expect(visibleBoard).toContain("2h19m");
  expect(visibleBoard).toContain("Jan 13 5:59p");
  expect(visibleBoard).toContain("12.5s/31w");
  expect(visibleBoard).toContain("0h00m");
  expect(visibleBoard).toContain("Jan 13 6:46p");
  expect(visibleBoard).not.toContain("2:19p");
  expect(visibleBoard).not.toContain("12:00p");
  expect(visibleBoard).not.toContain("Jan 12 2:19p");
  expect(visibleBoard).not.toContain("Jan 12 12:00p");
  expect(visibleBoard).not.toContain("99s/98w");
});

test("board shows input, cached, and output token details", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const working: JudgeOutcome = {
    ok: true,
    verdict: { confidence: 0.9, state: "working", summary: "" },
  };
  const deps: BabysitDeps = {
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
      cacheReadTokens: 3_400,
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
      inputTokens: 1_200,
      lastCompactionTs: new Date(START_MS - 10 * 60_000).toISOString(),
      messages: 0,
      model: "gpt-5.5",
      outputTokens: 7_800,
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
  const result = await babysitTick(states, baseConfig(), deps, {
    ...freshRunState(),
    llmTokens: 1000,
    llmUsage: {
      cachedInputTokens: 500,
      calls: 3,
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 2000,
    },
  });
  const visibleBoard = stripAnsi(result.board);

  expect(visibleBoard).toMatch(
    /AGENT\s+STATE\s+NOW\s+MODEL\s+EFF\s+MODE\s+CTX\s+CTX\+\s+CMP\s+LIMIT S\/W\s+S RESET\s+W RESET\s+COST\s+\$\/H\s+TOK\s+IN\s+CACHE\s+OUT\s+BRIDGE\s+LAST/
  );
  expect(visibleBoard).toMatch(
    /AGENT\s+ACT\s+TXT\s+THK\s+TOOL\s+EXEC\s+CODE\s+READ\/VIEW\s+PLAN\s+BRIDGE\s+OTHER/
  );
  expect(visibleBoard).toContain("TXT");
  expect(visibleBoard).toContain("THK");
  expect(visibleBoard).toContain("TOOL");
  expect(visibleBoard).toContain("med");
  expect(visibleBoard).toContain("fast/2.5x");
  expect(visibleBoard).toContain("IN");
  expect(visibleBoard).toContain("CACHE");
  expect(visibleBoard).toContain("OUT");
  expect(visibleBoard).toContain("CTX+");
  expect(visibleBoard).toContain("CMP");
  expect(visibleBoard).not.toContain("C/M");
  expect(visibleBoard).not.toContain("T85");
  expect(visibleBoard).not.toContain("IDLE");
  expect(visibleBoard).not.toContain("WORK");
  expect(visibleBoard).toContain("$/H");
  expect(visibleBoard).toContain("LIMIT S/W");
  expect(visibleBoard).toContain("S RESET");
  expect(visibleBoard).toContain("W RESET");
  expect(visibleBoard).toMatch(/claude\s+19\s+12\s+3\s+4\s+3\s+1/);
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
  expect(visibleBoard).toContain("70s/24w");
  expect(visibleBoard).toMatch(/claude\s+● thinking\s+(—|0s)\s+gpt-5\.5/);
  expect(visibleBoard).toMatch(/1\.1M\s+2\s+70s\/24w/);
  expect(visibleBoard).toMatch(/\$12\.00\s+\$42\s+13k\s+1k\s+4k\s+8k/);
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
  const longText = Array.from(
    { length: 80 },
    (_, i) => `detail${i}`
  ).join(" ");
  const summary = [
    `Project: ${longText}`,
    `Objective: ${longText}`,
    `Progress: ${longText}`,
    `Next: ${longText}`,
  ].join("\n");
  const states = new Map<Agent, AgentLivenessState>();
  const result = await babysitTick(
    states,
    baseConfig(),
    makeDeps(working, clock, spies),
    { ...freshRunState(), summary }
  );
  const lines = stripAnsi(result.board).split("\n");
  const summaryStart = lines.findIndex((line) => line.includes("── summary ──"));
  expect(summaryStart).toBeGreaterThanOrEqual(0);
  const sectionCounts: Record<string, number> = {};
  let current = "";
  for (const line of lines.slice(summaryStart + 1)) {
    const label = line.trimStart().match(/^(Project|Objective|Progress|Next):/i);
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
    progress: 3,
    project: 1,
  });
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
  const result = await babysitTick(states, baseConfig(), deps, {
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
  const deps: BabysitDeps = {
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
  const deps: BabysitDeps = {
    ...makeDeps(waitingHuman, clock, spies),
    capturePane: () =>
      "You've hit your session limit · resets 8:50pm (America/Los_Angeles)",
  };
  const states = new Map<Agent, AgentLivenessState>();
  const result = await babysitTick(states, baseConfig(), deps);

  expect(spies.judged).toBe(0);
  expect(result.board).toContain("limit");
  expect(result.board).not.toContain("waits you");
});

test("board does not label Codex context compaction as a usage limit", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps: BabysitDeps = {
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
  const result = await babysitTick(
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

const bothIdle = (clock: { ms: number }, spies: Spies): BabysitDeps => {
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
  const deps: BabysitDeps = {
    ...makeDeps(stuck, clock, spies),
    // claude's pane animates (thinking); codex ended its turn (idle).
    capturePane: (pane) => (pane.endsWith(".0") ? `frame ${frame++}` : "idle"),
    readHooks: (file) => (file.includes("codex") ? [stop] : []),
  };
  const config = baseConfig({ agents: twoAgents });
  const states = new Map<Agent, AgentLivenessState>();
  // Seed a confirmed waiting read; claude is active this tick, so it must clear.
  const result = await babysitTick(states, config, deps, {
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
  const t1 = await babysitTick(states, config, deps, seeded);
  expect(t1.board).toContain("waiting for you");
  expect(t1.board).toContain("Should I merge this now?");
  // A second tick must not re-escalate (deduped).
  await babysitTick(states, config, deps, t1.runState);
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
  const result = await babysitTick(states, config, deps, {
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
  const deps: BabysitDeps = {
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
  const first = await babysitTick(states, config, deps);
  await babysitTick(states, config, deps, first.runState);
  const budgetAlerts = spies.notifies.filter((e) => e.kind === "budget");
  expect(budgetAlerts).toHaveLength(1);
  expect(first.board).toContain("⛔");
});

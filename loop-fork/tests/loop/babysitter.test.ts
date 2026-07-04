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
  HookEvent,
  JudgeOutcome,
  RecoveryHistoryEntry,
} from "../../src/loop/types";

const IDLE_MS = 60_000;
const START_MS = 1_000_000;

const baseConfig = (overrides: Partial<BabysitConfig> = {}): BabysitConfig => ({
  agents: [{ agent: "claude", hookFile: "hooks.jsonl", pane: "s:0.0" }],
  budgetUsd: 0,
  confidence: 0.7,
  cooldownMs: 300_000,
  dryRun: false,
  escalateIdleMs: 300_000,
  idleMs: IDLE_MS,
  logFile: "babysitter.jsonl",
  maxRecoveries: 3,
  model: "m",
  runId: "1",
  session: "s",
  tickMs: 15_000,
  url: "http://127.0.0.1:8082",
  ...overrides,
});

interface Spies {
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
  capturePane: () => "stable pane text",
  judge: (_req) => {
    spies.judged += 1;
    return Promise.resolve(outcome);
  },
  loadState: () => undefined,
  notify: (_url, event) => spies.notifies.push(event),
  now: () => clock.ms,
  readBridge: () => ({}),
  readHooks: () => [],
  readHumanMessages: () => [],
  readUsage: () => ({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    costUsd: 0,
    humanMessages: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }),
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
  const result = await runToSuspect(baseConfig({ dryRun: true }), deps, clock);

  expect(spies.judged).toBe(1);
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
  expect(result.board).toContain("qwen ✗");
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

test("board uses the agent's live pane context % when present", async () => {
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
  expect(result.board).toContain("61%");
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

const twoAgents = [
  { agent: "claude" as Agent, hookFile: "claude.jsonl", pane: "s:0.0" },
  { agent: "codex" as Agent, hookFile: "codex.jsonl", pane: "s:0.1" },
];

test("a lone idle agent whose peer is active is not 'waiting for you'", async () => {
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
  const config = baseConfig({ agents: twoAgents, escalateIdleMs: 1000 });
  const states = new Map<Agent, AgentLivenessState>();
  const t1 = await babysitTick(states, config, deps);
  clock.ms += 5000;
  const t2 = await babysitTick(states, config, deps, t1.runState);
  clock.ms += 5000;
  const t3 = await babysitTick(states, config, deps, t2.runState);
  expect(t3.board).not.toContain("waiting for you");
  expect(spies.notifies.filter((e) => e.kind === "waiting-human")).toHaveLength(
    0
  );
});

test("both agents idle surfaces the pending question and escalates once", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const stop: HookEvent = {
    event: "Stop",
    ts: new Date(START_MS).toISOString(),
  };
  const deps: BabysitDeps = {
    ...makeDeps(stuck, clock, spies),
    capturePane: (pane) =>
      pane.endsWith(".0") ? "Should I merge this now?" : "done",
    readHooks: () => [stop],
  };
  const config = baseConfig({ agents: twoAgents, escalateIdleMs: 1000 });
  const states = new Map<Agent, AgentLivenessState>();
  const t1 = await babysitTick(states, config, deps);
  clock.ms += 90_000; // past both the display and escalation thresholds
  const t2 = await babysitTick(states, config, deps, t1.runState);
  expect(t2.board).toContain("waiting for you");
  expect(t2.board).toContain("Should I merge this now?");
  const waits = spies.notifies.filter((e) => e.kind === "waiting-human");
  expect(waits).toHaveLength(1);
  expect(waits[0].message).toContain("Should I merge this now?");
});

test("escalates once when an agent waits for the human past the threshold", async () => {
  const clock = { ms: START_MS };
  const spies = freshSpies();
  const deps = makeDeps(waitingHuman, clock, spies);
  const config = baseConfig({ escalateIdleMs: 1000 });
  const states = new Map<Agent, AgentLivenessState>();
  const t1 = await babysitTick(states, config, deps);
  clock.ms = START_MS + 2 * IDLE_MS; // becomes suspect + waiting-human
  const t2 = await babysitTick(states, config, deps, t1.runState);
  expect(spies.notifies).toHaveLength(0); // just entered waiting
  clock.ms += 2000; // now past the 1s escalation threshold
  const t3 = await babysitTick(states, config, deps, t2.runState);
  clock.ms += 2000;
  await babysitTick(states, config, deps, t3.runState);
  const waits = spies.notifies.filter((e) => e.kind === "waiting-human");
  expect(waits).toHaveLength(1); // deduped across subsequent ticks
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
      contextTokens: 0,
      contextWindow: 200_000,
      costUsd: 60,
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

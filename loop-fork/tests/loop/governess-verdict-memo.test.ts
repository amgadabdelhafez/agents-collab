import { expect, test } from "bun:test";
import {
  freshRunState,
  type GovernessConfig,
  type GovernessDeps,
  governessTick,
} from "../../src/loop/governess";
import type { AgentLivenessState } from "../../src/loop/governess-detect";
import type { Agent, AgentUsage } from "../../src/loop/types";

const IDLE_MS = 120_000;
const START_MS = 1_000_000_000;
const BLOCKED_PANE = "△ Permission required\n  Allow once   Allow always";

const emptyUsage = (): AgentUsage =>
  ({
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
  }) as AgentUsage;

const config = (): GovernessConfig =>
  ({
    agentRenameEnabled: false,
    agents: [{ agent: "claude" as const, hookFile: "h.jsonl", pane: "s:0.0" }],
    budgetUsd: 0,
    confidence: 0.7,
    cooldownMs: 300_000,
    dryRun: true,
    epoch: 1,
    escalateIdleMs: 300_000,
    idleMs: IDLE_MS,
    judgeMode: "consensus",
    logFile: "governess.jsonl",
    maxRecoveries: 3,
    model: "m",
    runId: "36",
    session: "s",
    tickMs: 15_000,
    url: "http://127.0.0.1:8082",
    usageTrackerTimeoutMs: 1500,
  }) as unknown as GovernessConfig;

const deps = (clock: { ms: number }, judged: { n: number }): GovernessDeps =>
  ({
    appendLog: () => undefined,
    assessRoleBalance: () =>
      Promise.resolve({
        confidence: 0,
        reason: "",
        switchDriver: false,
        tokens: 0,
      }),
    assessWaiting: () =>
      Promise.resolve({ ask: "", tokens: 0, waiting: false }),
    capturePane: () => BLOCKED_PANE,
    fenceCurrent: () => true,
    initPaneBorders: () => undefined,
    judge: () => {
      judged.n += 1;
      return Promise.resolve({
        ok: true as const,
        verdict: {
          confidence: 1,
          state: "waiting-human",
          suggestedAction: "Answer the prompt.",
          summary: "Agent idle awaiting next request.",
        },
      });
    },
    labelPanes: () => Promise.resolve({ labels: {}, tokens: 0 }),
    loadState: () => undefined,
    notify: () => undefined,
    now: () => clock.ms,
    readBridge: () => ({}),
    readBridgeLatest: () => ({}),
    readHooks: () => [],
    readHumanMessages: () => [],
    readLocalLlmRuntime: () => ({}),
    readUsage: () => emptyUsage(),
    readUsageLimits: () => Promise.resolve(undefined),
    render: () => undefined,
    replacementSessionReady: () => false,
    respawnPane: () => undefined,
    saveState: () => undefined,
    sendBridge: () => Promise.resolve("accepted" as const),
    sendKeys: () => undefined,
    sendText: () => undefined,
    setGovernessPaneIdentity: () => undefined,
    setPaneLabel: () => undefined,
    sleep: () => Promise.resolve(),
    summarize: () => Promise.resolve({ text: "", tokens: 0 }),
  }) as unknown as GovernessDeps;

// Rows are rebuilt every tick and carry no verdict of their own. Without the
// memo, a tick that skips the judge drops back to the thinking/idle guess and
// a seat blocked on a modal reads as working - which is what run 36 showed.
test("a waiting-human verdict survives a tick that skips the judge", async () => {
  const clock = { ms: START_MS };
  const judged = { n: 0 };
  const states = new Map<Agent, AgentLivenessState>();
  const cfg = config();
  const d = deps(clock, judged);

  // Tick 1 establishes the pane. Tick 2, with the pane unchanged and events
  // stale, makes the seat suspect and the judge returns waiting-human.
  const t1 = await governessTick(states, cfg, d, freshRunState());
  clock.ms += IDLE_MS + 1;
  const t2 = await governessTick(states, cfg, d, t1.runState);

  expect(judged.n).toBeGreaterThan(0);
  const remembered = t2.runState.seatVerdict.claude;
  expect(remembered?.verdict.state).toBe("waiting-human");
  expect(remembered?.since).toBeGreaterThan(0);
});

test("the remembered state keeps its start time while the state holds", async () => {
  const clock = { ms: START_MS };
  const judged = { n: 0 };
  const states = new Map<Agent, AgentLivenessState>();
  const cfg = config();
  const d = deps(clock, judged);

  const t1 = await governessTick(states, cfg, d, freshRunState());
  clock.ms += IDLE_MS + 1;
  const t2 = await governessTick(states, cfg, d, t1.runState);
  const firstSince = t2.runState.seatVerdict.claude?.since;
  clock.ms += IDLE_MS + 1;
  const t3 = await governessTick(states, cfg, d, t2.runState);

  // Still waiting-human, so the clock must not restart: that elapsed time is
  // what the escalation threshold is measured against.
  expect(t3.runState.seatVerdict.claude?.verdict.state).toBe("waiting-human");
  expect(t3.runState.seatVerdict.claude?.since).toBe(firstSince);
});

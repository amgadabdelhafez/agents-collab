import { expect, mock, test } from "bun:test";
import type { Agent } from "../../src/loop/types";
import {
  type BabysitterState,
  type BabysitterVerdict,
  decideRecovery,
  type RecoveryDeps,
  type RecoveryHistoryEntry,
  executeRecovery,
} from "../../src/loop/babysitter-recover";

const AGENT: Agent = "claude";
const NOW_ISO = "2026-07-04T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const verdict = (
  state: BabysitterState,
  confidence: number
): BabysitterVerdict => ({ state, confidence });

const gateOpts = (overrides: Partial<{
  confidence: number;
  cooldownMs: number;
  maxRecoveries: number;
  nowMs: number;
}> = {}) => ({
  confidence: 0.5,
  cooldownMs: 60_000,
  maxRecoveries: 3,
  nowMs: NOW_MS,
  ...overrides,
});

const entry = (
  level: RecoveryHistoryEntry["level"],
  ts: string,
  agent: Agent = AGENT
): RecoveryHistoryEntry => ({ agent, level, ts });

const makeDeps = (): RecoveryDeps => ({
  answerPrompt: mock(() => undefined),
  nudge: mock(() => undefined),
  restart: mock(() => undefined),
  log: mock(() => undefined),
});

test("non-recoverable state 'working' yields level null", () => {
  const decision = decideRecovery(verdict("working", 1), [], AGENT, gateOpts());
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("state working not recoverable");
  expect(decision.agent).toBe(AGENT);
});

test("non-recoverable state 'waiting-human' yields level null", () => {
  const decision = decideRecovery(
    verdict("waiting-human", 1),
    [],
    AGENT,
    gateOpts()
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("state waiting-human not recoverable");
});

test("non-recoverable state 'waiting-peer' yields level null", () => {
  const decision = decideRecovery(
    verdict("waiting-peer", 1),
    [],
    AGENT,
    gateOpts()
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("state waiting-peer not recoverable");
});

test("stuck with confidence below the gate yields level null", () => {
  const decision = decideRecovery(
    verdict("stuck", 0.4),
    [],
    AGENT,
    gateOpts({ confidence: 0.5 })
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("confidence below gate");
});

test("max recoveries reached yields level null", () => {
  const history = [
    entry("answer-prompt", "2026-07-04T00:00:00.000Z"),
    entry("nudge", "2026-07-04T00:00:01.000Z"),
    entry("restart", "2026-07-04T00:00:02.000Z"),
  ];
  const decision = decideRecovery(
    verdict("stuck", 1),
    history,
    AGENT,
    gateOpts({ maxRecoveries: 3 })
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("max recoveries reached");
});

test("cooldown active (last action within window) yields level null", () => {
  // last action 10s before now, cooldown 60s -> still cooling down.
  const lastTs = new Date(NOW_MS - 10_000).toISOString();
  const history = [entry("answer-prompt", lastTs)];
  const decision = decideRecovery(
    verdict("crashed", 1),
    history,
    AGENT,
    gateOpts({ cooldownMs: 60_000 })
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("cooldown active");
});

test("escalation: empty history escalates to answer-prompt", () => {
  const decision = decideRecovery(verdict("stuck", 1), [], AGENT, gateOpts());
  expect(decision.level).toBe("answer-prompt");
  expect(decision.reason).toBe("escalate to answer-prompt");
});

test("escalation: one prior answer-prompt escalates to nudge", () => {
  // old timestamp so cooldown does not trigger.
  const history = [entry("answer-prompt", "2026-07-01T00:00:00.000Z")];
  const decision = decideRecovery(
    verdict("stuck", 1),
    history,
    AGENT,
    gateOpts()
  );
  expect(decision.level).toBe("nudge");
  expect(decision.reason).toBe("escalate to nudge");
});

test("escalation: two priors escalate to restart", () => {
  const history = [
    entry("answer-prompt", "2026-07-01T00:00:00.000Z"),
    entry("nudge", "2026-07-01T00:00:01.000Z"),
  ];
  const decision = decideRecovery(
    verdict("stuck", 1),
    history,
    AGENT,
    gateOpts()
  );
  expect(decision.level).toBe("restart");
  expect(decision.reason).toBe("escalate to restart");
});

test("escalation: three priors (== max 3) yields level null", () => {
  const history = [
    entry("answer-prompt", "2026-07-01T00:00:00.000Z"),
    entry("nudge", "2026-07-01T00:00:01.000Z"),
    entry("restart", "2026-07-01T00:00:02.000Z"),
  ];
  const decision = decideRecovery(
    verdict("stuck", 1),
    history,
    AGENT,
    gateOpts({ maxRecoveries: 3 })
  );
  expect(decision.level).toBeNull();
  expect(decision.reason).toBe("max recoveries reached");
});

test("history for other agents does not affect this agent's escalation", () => {
  const history = [
    entry("answer-prompt", "2026-07-01T00:00:00.000Z", "codex"),
    entry("nudge", "2026-07-01T00:00:01.000Z", "codex"),
  ];
  const decision = decideRecovery(
    verdict("stuck", 1),
    history,
    AGENT,
    gateOpts()
  );
  expect(decision.level).toBe("answer-prompt");
});

test("executeRecovery with level null returns null and calls nothing", () => {
  const deps = makeDeps();
  const result = executeRecovery(
    { agent: AGENT, level: null, reason: "cooldown active" },
    deps,
    { dryRun: false, nowIso: NOW_ISO }
  );
  expect(result).toBeNull();
  expect(deps.log).not.toHaveBeenCalled();
  expect(deps.answerPrompt).not.toHaveBeenCalled();
  expect(deps.nudge).not.toHaveBeenCalled();
  expect(deps.restart).not.toHaveBeenCalled();
});

test("executeRecovery dryRun logs with dryRun true and calls no executor", () => {
  const deps = makeDeps();
  const result = executeRecovery(
    { agent: AGENT, level: "restart", reason: "escalate to restart" },
    deps,
    { dryRun: true, nowIso: NOW_ISO }
  );

  expect(result).toEqual({ agent: AGENT, level: "restart", ts: NOW_ISO });
  expect(deps.log).toHaveBeenCalledTimes(1);
  expect(deps.log).toHaveBeenCalledWith(
    { agent: AGENT, level: "restart", ts: NOW_ISO },
    true
  );
  expect(deps.answerPrompt).not.toHaveBeenCalled();
  expect(deps.nudge).not.toHaveBeenCalled();
  expect(deps.restart).not.toHaveBeenCalled();
});

test("executeRecovery non-dryRun restart invokes restart once and logs", () => {
  const deps = makeDeps();
  const result = executeRecovery(
    { agent: AGENT, level: "restart", reason: "escalate to restart" },
    deps,
    { dryRun: false, nowIso: NOW_ISO }
  );

  expect(result).toEqual({ agent: AGENT, level: "restart", ts: NOW_ISO });
  expect(deps.log).toHaveBeenCalledTimes(1);
  expect(deps.log).toHaveBeenCalledWith(
    { agent: AGENT, level: "restart", ts: NOW_ISO },
    false
  );
  expect(deps.restart).toHaveBeenCalledTimes(1);
  expect(deps.restart).toHaveBeenCalledWith(AGENT);
  expect(deps.answerPrompt).not.toHaveBeenCalled();
  expect(deps.nudge).not.toHaveBeenCalled();
});

test("executeRecovery non-dryRun answer-prompt invokes answerPrompt once", () => {
  const deps = makeDeps();
  executeRecovery(
    { agent: AGENT, level: "answer-prompt", reason: "escalate to answer-prompt" },
    deps,
    { dryRun: false, nowIso: NOW_ISO }
  );
  expect(deps.answerPrompt).toHaveBeenCalledTimes(1);
  expect(deps.answerPrompt).toHaveBeenCalledWith(AGENT);
  expect(deps.nudge).not.toHaveBeenCalled();
  expect(deps.restart).not.toHaveBeenCalled();
});

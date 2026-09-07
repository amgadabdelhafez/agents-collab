import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectEscalations,
  freshRunState,
  type GovernessConfig,
  type GovernessRunState,
} from "../../src/loop/governess";
import {
  appendEscalation,
  type EscalationEvent,
} from "../../src/loop/governess-notify";

const NOW = 1_000_000_000;
const IDLE_MS = 120_000;

const config = (): GovernessConfig =>
  ({
    agents: [
      { agent: "claude" as const, hookFile: "", pane: "%1" },
      { agent: "oss" as const, hookFile: "", pane: "%2" },
    ],
    budgetUsd: 0,
    escalateIdleMs: IDLE_MS,
    maxRecoveries: 3,
    runId: "36",
  }) as unknown as GovernessConfig;

// One seat blocked, its peer working: exactly run 36.
const oneSeatBlocked = (blockedForMs: number): GovernessRunState => {
  const state = freshRunState();
  state.seatVerdict.oss = {
    paneHash: "abc",
    since: NOW - blockedForMs,
    verdict: {
      confidence: 1,
      state: "waiting-human",
      suggestedAction: "Answer the permission prompt.",
      summary: "Agent completed analysis, currently idle.",
    },
  };
  state.seatVerdict.claude = {
    paneHash: "def",
    since: NOW - blockedForMs,
    verdict: { confidence: 1, state: "working", summary: "working" },
  };
  return state;
};

const notWaiting = { ask: "", confirmed: false, ms: 0 };

describe("a single blocked seat escalates", () => {
  test("run 36: one seat waiting-human past the threshold, peer working", () => {
    const events = collectEscalations(
      oneSeatBlocked(IDLE_MS + 1),
      notWaiting,
      0,
      config(),
      NOW
    );
    const waiting = events.filter((e) => e.kind === "waiting-human");
    expect(waiting.length).toBe(1);
    expect(waiting[0]?.agent).toBe("oss");
    expect(waiting[0]?.message).toContain("blocked on you");
    // The judge's suggestion is carried so the reader knows what to do.
    expect(waiting[0]?.message).toContain("Answer the permission prompt.");
  });

  test("under the threshold nothing is raised", () => {
    const events = collectEscalations(
      oneSeatBlocked(IDLE_MS - 1),
      notWaiting,
      0,
      config(),
      NOW
    );
    expect(events.filter((e) => e.kind === "waiting-human").length).toBe(0);
  });

  test("it fires once per blocked stretch, not once per tick", () => {
    const state = oneSeatBlocked(IDLE_MS + 1);
    const first = collectEscalations(state, notWaiting, 0, config(), NOW);
    const second = collectEscalations(state, notWaiting, 0, config(), NOW);
    expect(first.filter((e) => e.kind === "waiting-human").length).toBe(1);
    expect(second.filter((e) => e.kind === "waiting-human").length).toBe(0);
  });

  test("the latch resets, so a second block escalates again", () => {
    const state = oneSeatBlocked(IDLE_MS + 1);
    collectEscalations(state, notWaiting, 0, config(), NOW);
    // Seat answers and goes back to work.
    state.seatVerdict.oss = {
      paneHash: "xyz",
      since: NOW,
      verdict: { confidence: 1, state: "working", summary: "working" },
    };
    collectEscalations(state, notWaiting, 0, config(), NOW);
    // And blocks again later.
    state.seatVerdict.oss = {
      paneHash: "qrs",
      since: NOW,
      verdict: { confidence: 1, state: "waiting-human", summary: "blocked" },
    };
    const again = collectEscalations(
      state,
      notWaiting,
      0,
      config(),
      NOW + IDLE_MS + 1
    );
    expect(again.filter((e) => e.kind === "waiting-human").length).toBe(1);
  });

  test("a seat that never blocks raises nothing", () => {
    const state = freshRunState();
    state.seatVerdict.oss = {
      paneHash: "a",
      since: NOW - 10 * IDLE_MS,
      verdict: { confidence: 1, state: "working", summary: "working" },
    };
    expect(
      collectEscalations(state, notWaiting, 0, config(), NOW).filter(
        (e) => e.kind === "waiting-human"
      ).length
    ).toBe(0);
  });
});

describe("the escalation record needs no configuration", () => {
  const event: EscalationEvent = {
    agent: "oss",
    kind: "waiting-human",
    message: "oss has been blocked on you for 2h39m",
    priority: "high",
    title: "oss is blocked on you",
  };

  test("every escalation lands in the run dir even with no ntfy topic", () => {
    const file = join(mkdtempSync(join(tmpdir(), "esc-")), "escalations.jsonl");
    appendEscalation(file, event, "2026-09-07T00:00:00.000Z");
    appendEscalation(file, event, "2026-09-07T00:05:00.000Z");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first.kind).toBe("waiting-human");
    expect(first.agent).toBe("oss");
    expect(first.at).toBe("2026-09-07T00:00:00.000Z");
  });

  test("no path configured is a no-op, never a throw into the control loop", () => {
    expect(() =>
      appendEscalation(undefined, event, "2026-09-07T00:00:00.000Z")
    ).not.toThrow();
    expect(() =>
      appendEscalation("/nonexistent-dir-xyz/e.jsonl", event, "t")
    ).not.toThrow();
  });
});

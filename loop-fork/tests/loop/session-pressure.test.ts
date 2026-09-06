import { describe, expect, test } from "bun:test";
import {
  evaluateSessionPressure,
  pressureAtOrAboveHandoff,
  sessionPressureModeFromEnv,
  sessionPressureProfile,
} from "../../src/loop/session-pressure";
import type { AgentUsage } from "../../src/loop/types";

const usage = (overrides: Partial<AgentUsage> = {}): AgentUsage => ({
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  compactedContextTokens: 0,
  compactions: 0,
  contextRateTokensPerMinute: 0,
  contextTokens: 0,
  contextWindow: 0,
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
  ...overrides,
});

describe("session pressure profiles", () => {
  test("selects model-specific thresholds instead of one global turn count", () => {
    // Derived from each model's real window, so the maintained profiles land
    // within a rounding step of the absolutes they were tuned with.
    expect(sessionPressureProfile("codex", "gpt-5.6-sol")).toMatchObject({
      contextHandoffTokens: 184_960,
      turnHandoff: 18,
    });
    expect(sessionPressureProfile("codex", "gpt-5.5")).toMatchObject({
      contextHandoffTokens: 225_760,
      turnHandoff: 96,
    });
    expect(sessionPressureProfile("claude", "Claude Opus 4.8")).toMatchObject({
      turnHandoff: 95,
    });
  });

  test("a model with no resolvable window keeps its tuned absolute", () => {
    // "Codex Spark" is not a catalog id. Multiplying the 200k default by the
    // share would invent a threshold; the absolute stands instead.
    expect(sessionPressureProfile("codex", "Codex Spark")).toMatchObject({
      contextHandoffTokens: 105_000,
      turnHandoff: 11,
    });
  });

  test("a 1M-window Claude seat hands off at its share of 1M, not at 230k (H7)", () => {
    // The absolute predates 1,000,000-token windows: every Claude seat was
    // handing off at 23% of its context. harness-engineering run 21 was
    // driven into a handover at 205,736 tokens on 2026-09-06.
    for (const model of [
      "claude-opus-5",
      "claude-opus-4.8",
      "claude-fable-5",
    ]) {
      const profile = sessionPressureProfile("claude", model);
      expect(profile.contextHandoffTokens).toBe(750_000);
      expect(profile.contextHandoffTokens).not.toBe(230_000);
    }
  });

  test("an explicit window from the seat beats the catalog", () => {
    expect(
      sessionPressureProfile("claude", "claude-opus-5", 400_000)
        .contextHandoffTokens
    ).toBe(300_000);
  });
});

describe("evaluateSessionPressure", () => {
  test("prepares and hands off GPT-5.6 from measured context first", () => {
    const prepare = evaluateSessionPressure(
      "codex",
      usage({ contextTokens: 138_750, messages: 1, model: "gpt-5.6-sol" })
    );
    expect(prepare).toMatchObject({
      contextPrepareTokens: 138_720,
      phase: "prepare",
      reasonCode: "context-prepare",
    });
    const handoff = evaluateSessionPressure(
      "codex",
      usage({ contextTokens: 185_000, messages: 18, model: "gpt-5.6-sol" })
    );
    expect(handoff).toMatchObject({
      phase: "handoff",
      reasonCode: "context-handoff",
    });
  });

  test("does not prepare or hand off from high turns at low context", () => {
    const codex = evaluateSessionPressure(
      "codex",
      usage({ contextTokens: 111_000, messages: 18, model: "gpt-5.6-sol" })
    );
    expect(codex).toMatchObject({
      assistantTurns: 18,
      contextUsedPct: 60,
      phase: "healthy",
      reasonCode: "below-thresholds",
    });

    const claude = evaluateSessionPressure(
      "claude",
      usage({
        contextTokens: 39_100,
        messages: 68,
        model: "Claude Opus 5",
      })
    );
    expect(claude).toMatchObject({
      assistantTurns: 68,
      contextUsedPct: 17,
      phase: "healthy",
      reasonCode: "below-thresholds",
    });
  });

  test("compaction precedence outranks context and turn crossings", () => {
    expect(
      evaluateSessionPressure(
        "codex",
        usage({
          compactions: 1,
          contextTokens: 300_000,
          messages: 200,
          model: "gpt-5.6-sol",
        })
      )
    ).toMatchObject({ phase: "handoff", reasonCode: "first-compaction" });
    const ceiling = evaluateSessionPressure(
      "claude",
      usage({ compactions: 2, model: "Claude Opus 5" })
    );
    expect(ceiling).toMatchObject({
      phase: "hard-ceiling",
      reasonCode: "multiple-compactions",
    });
    expect(pressureAtOrAboveHandoff(ceiling)).toBe(true);
  });

  test("does not treat an explicitly manual Claude compaction as automatic", () => {
    const result = evaluateSessionPressure(
      "claude",
      usage({
        automaticCompactions: 0,
        compactions: 1,
        contextTokens: 10_000,
        messages: 1,
        model: "Claude Opus 5",
      })
    );
    expect(result).toMatchObject({
      automaticCompactions: 0,
      compactionBasis: "automatic",
      phase: "healthy",
    });
  });

  test("does not fabricate context pressure when context is unknown", () => {
    const result = evaluateSessionPressure(
      "claude",
      usage({ contextTokens: Number.NaN, messages: 1, model: "Claude Opus 5" })
    );
    expect(result.phase).toBe("healthy");
    expect(result.contextTokens).toBeUndefined();
    expect(result.contextUsedPct).toBeUndefined();
    expect(result.reason).toContain("context unavailable");
  });
});

test("context handoff mode defaults to enforce with explicit observe and off", () => {
  expect(sessionPressureModeFromEnv({})).toBe("enforce");
  expect(
    sessionPressureModeFromEnv({ LOOP_GOVERNESS_CONTEXT_HANDOFF: "observe" })
  ).toBe("observe");
  expect(
    sessionPressureModeFromEnv({ LOOP_GOVERNESS_CONTEXT_HANDOFF: "off" })
  ).toBe("off");
  expect(
    sessionPressureModeFromEnv({ LOOP_GOVERNESS_CONTEXT_HANDOFF: "invalid" })
  ).toBe("enforce");
});

describe("H7: the run 21 numbers", () => {
  test("205,736 tokens on a 1M seat is healthy, not a handoff", () => {
    const decision = evaluateSessionPressure(
      "claude",
      usage({
        contextTokens: 205_736,
        contextWindow: 1_000_000,
        messages: 40,
        model: "claude-opus-5",
      })
    );
    expect(decision.phase).toBe("healthy");
    expect(decision.reasonCode).toBe("below-thresholds");
    expect(decision.contextHandoffTokens).toBe(750_000);
    expect(decision.contextUsedPct).toBe(27);
  });

  test("the same seat still hands off once it is genuinely deep", () => {
    const decision = evaluateSessionPressure(
      "claude",
      usage({
        contextTokens: 800_000,
        contextWindow: 1_000_000,
        messages: 40,
        model: "claude-opus-5",
      })
    );
    expect(decision.phase).toBe("handoff");
    expect(decision.reasonCode).toBe("context-handoff");
  });
});

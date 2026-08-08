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
    expect(sessionPressureProfile("codex", "gpt-5.6-sol")).toMatchObject({
      contextHandoffTokens: 185_000,
      turnHandoff: 18,
    });
    expect(sessionPressureProfile("codex", "gpt-5.5")).toMatchObject({
      contextHandoffTokens: 225_000,
      turnHandoff: 96,
    });
    expect(sessionPressureProfile("codex", "Codex Spark")).toMatchObject({
      contextHandoffTokens: 105_000,
      turnHandoff: 11,
    });
    expect(sessionPressureProfile("claude", "Claude Opus 4.8")).toMatchObject({
      contextHandoffTokens: 230_000,
      turnHandoff: 95,
    });
  });
});

describe("evaluateSessionPressure", () => {
  test("prepares and hands off GPT-5.6 from measured context first", () => {
    const prepare = evaluateSessionPressure(
      "codex",
      usage({ contextTokens: 138_750, messages: 1, model: "gpt-5.6-sol" })
    );
    expect(prepare).toMatchObject({
      contextPrepareTokens: 138_750,
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

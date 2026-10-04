import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, spawnSync } from "bun";
import {
  formatGovernessCost,
  governessCost,
} from "../../src/loop/governess-cost";
import {
  applyPricing,
  readAgentUsage,
  readHumanMessages,
  summarizeClaude,
  summarizeCodex,
} from "../../src/loop/governess-usage";
import { applyUsageTrackerPricing } from "../../src/loop/governess-usage-limits";

test("tracker API prices current models without local model rates", () => {
  const pricing = {
    codexCreditUsd: 0.04,
    source: "usage-tracker-api",
    rates: [
      {
        provider: "codex" as const,
        modelPrefix: "gpt-6.1-sol",
        basis: "credits_per_mtok" as const,
        rates: { input: 50, output: 250, cacheRead: 2.5 },
      },
      {
        provider: "claude" as const,
        modelPrefix: "claude-sonnet-5-5",
        basis: "api_usd_per_mtok" as const,
        rates: {
          input: 2,
          output: 10,
          cacheRead: 0.2,
          cacheWrite: 2.5,
          cacheWrite1h: 4,
        },
      },
    ],
  };
  const usage = {
    ...summarizeCodex(""),
    model: "gpt-6.1-sol",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };
  applyUsageTrackerPricing(usage, "codex", pricing);
  expect(usage.costUsd).toBe(12.1);
  expect(usage.costEstimateBasis).toBe("credit-estimate");
  expect(usage.costEstimateCoveragePct).toBe(100);
  usage.model = "claude-sonnet-5-5";
  usage.cacheCreateTokens = 2_000_000;
  usage.cacheCreate1hTokens = 1_000_000;
  applyUsageTrackerPricing(usage, "claude", pricing);
  expect(usage.costUsd).toBe(18.7);
  expect(usage.costEstimateBasis).toBe("api-usd");
  applyUsageTrackerPricing(usage, "claude", { ...pricing, rates: [] });
  expect(usage.costEstimateCoveragePct).toBe(0);
});

import {
  deriveRoutingCost,
  PRICE_CACHE_MAX_AGE_MS,
  parseRoutingUsage,
  priceRoutingUsage,
} from "../../src/loop/routing-cost";
import {
  createRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";

const claudeLine = (
  ts: string,
  usage: Record<string, unknown>,
  model = "claude-opus-4-8"
): string => JSON.stringify({ message: { model, usage }, timestamp: ts });

test("metadata-only Codex rollout does not invent model or exact usage", () => {
  const usage = summarizeCodex(
    JSON.stringify({
      type: "session_meta",
      payload: { id: "bound-empty-thread" },
    })
  );
  expect(usage.model).toBeUndefined();
  expect(usage.dataConfidence).toBe("missing");
  expect(usage.totalTokens).toBe(0);
  expect(
    applyPricing({ ...usage, model: "unknown-unpriced-provider-model" })
      .costEstimateCoveragePct
  ).toBe(0);
});

test("human message extraction keeps the launch task and drops bridge results", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-codex-human-messages-"));
  const thread = "019f-human-message-test";
  const sessionDir = join(root, "sessions", "2026", "07", "28");
  mkdirSync(sessionDir, { recursive: true });
  const userMessage = (text: string): string =>
    JSON.stringify({
      payload: {
        content: [{ text, type: "input_text" }],
        role: "user",
        type: "message",
      },
      type: "response_item",
    });
  writeFileSync(
    join(sessionDir, `rollout-2026-07-28T00-00-00-${thread}.jsonl`),
    [
      userMessage(
        "Agent-to-agent pair programming: Claude is primary.\n\nTask:\n# Loop-57 — EXECUTION: analyser to census\n\nMore harness guidance."
      ),
      userMessage("fix the test"),
      userMessage(
        "[bridge type=handover task=abc] Helper: result with a false objective"
      ),
    ].join("\n")
  );
  try {
    expect(readHumanMessages("codex", thread, root)).toEqual([
      "Task: Loop-57 — EXECUTION: analyser to census",
      "fix the test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizeClaude sums usage across assistant turns and tracks context", () => {
  const text = [
    claudeLine("2026-07-04T00:00:00Z", {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 40 },
    }),
    claudeLine("2026-07-04T00:05:00Z", {
      input_tokens: 5,
      output_tokens: 200,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    }),
  ].join("\n");

  const u = summarizeClaude(text);
  expect(u.inputTokens).toBe(15);
  expect(u.outputTokens).toBe(300);
  expect(u.cacheReadTokens).toBe(3000);
  expect(u.cacheCreateTokens).toBe(50);
  expect(u.cacheCreate1hTokens).toBe(40);
  expect(u.totalTokens).toBe(15 + 300 + 3000 + 50);
  // context ≈ latest turn's input context: 5 + 2000 + 0
  expect(u.contextTokens).toBe(2005);
  expect(u.model).toBe("claude-opus-4-8");
  expect(u.firstTs).toBe("2026-07-04T00:00:00Z");
  expect(u.lastTs).toBe("2026-07-04T00:05:00Z");
  expect(u.contextRateTokensPerMinute).toBeCloseTo(189, 5);
  expect(u.dataConfidence).toBe("exact");
});

test("summarizeClaude dedupes split assistant rows with the same request id", () => {
  const repeatedUsage = {
    input_tokens: 10,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 50,
  };
  const splitRow = (ts: string, contentType: string): string =>
    JSON.stringify({
      message: {
        content: [
          contentType === "tool_use"
            ? { name: "Bash", type: contentType }
            : { type: contentType },
        ],
        id: "msg-split",
        model: "claude-opus-4-8",
        role: "assistant",
        usage: repeatedUsage,
      },
      requestId: "req-split",
      timestamp: ts,
      type: "assistant",
    });
  const text = [
    splitRow("2026-07-04T00:00:00Z", "thinking"),
    splitRow("2026-07-04T00:00:01Z", "text"),
    splitRow("2026-07-04T00:00:02Z", "tool_use"),
    JSON.stringify({
      message: {
        model: "claude-opus-4-8",
        role: "assistant",
        usage: {
          input_tokens: 5,
          output_tokens: 200,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 0,
        },
      },
      timestamp: "2026-07-04T00:05:00Z",
      type: "assistant",
    }),
  ].join("\n");

  const u = summarizeClaude(text);
  expect(u.messages).toBe(2);
  expect(u.inputTokens).toBe(15);
  expect(u.outputTokens).toBe(300);
  expect(u.cacheReadTokens).toBe(3000);
  expect(u.cacheCreateTokens).toBe(50);
  expect(u.totalTokens).toBe(15 + 300 + 3000 + 50);
  expect(u.contextTokens).toBe(2005);
  expect(u.textMessages).toBe(1);
  expect(u.thinkingMessages).toBe(1);
  expect(u.toolCalls).toBe(1);
  expect(u.toolCallCounts).toEqual({ Bash: 1 });
});

test("summarizeClaude tracks speed and service tier", () => {
  const u = summarizeClaude(
    claudeLine("2026-07-04T00:00:00Z", {
      input_tokens: 10,
      output_tokens: 100,
      service_tier: "standard",
      speed: "standard",
    })
  );

  expect(u.serviceTier).toBe("standard");
  expect(u.speed).toBe("standard");
  expect(u.creditCostMultiplier).toBe(1);
});

test("summarizeClaude ignores malformed lines and lines without usage", () => {
  const text = [
    "not json{{{",
    JSON.stringify({ type: "user", message: { role: "user" } }),
    claudeLine("2026-07-04T00:00:00Z", { input_tokens: 1, output_tokens: 2 }),
  ].join("\n");
  const u = summarizeClaude(text);
  expect(u.inputTokens).toBe(1);
  expect(u.outputTokens).toBe(2);
});

test("summarizeClaude ignores synthetic zero-usage error entries for model and context", () => {
  const text = [
    claudeLine("2026-07-04T00:00:00Z", {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
    }),
    JSON.stringify({
      error: "rate_limit",
      isApiErrorMessage: true,
      message: {
        model: "<synthetic>",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      timestamp: "2026-07-04T00:05:00Z",
      type: "assistant",
    }),
  ].join("\n");
  const u = summarizeClaude(text);
  expect(u.model).toBe("claude-opus-4-8");
  expect(u.contextTokens).toBe(1060);
  expect(u.totalTokens).toBe(1160);
});

test("summarizeClaude counts agent messages and genuine human prompts", () => {
  const text = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "do X" },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "Agent-to-agent pair programming: Codex is the primary agent",
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "governess: Codex is at/near session limit",
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "[Request interrupted by user for tool use]",
      },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Codex: please review this patch" },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    }),
    // meta reminder — not a human prompt
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "<reminder>" },
    }),
    // tool result — not a human prompt
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "r" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  ].join("\n");
  const u = summarizeClaude(text);
  expect(u.messages).toBe(2);
  expect(u.humanMessages).toBe(1);
});

test("summarizeClaude counts compact boundaries and pre-compact context", () => {
  const text = [
    claudeLine("2026-07-04T00:00:00Z", {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
    }),
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 999_624 },
      timestamp: "2026-07-04T01:00:00Z",
    }),
    // Supporting records around the boundary must not be counted as another
    // compaction.
    JSON.stringify({
      type: "attachment",
      attachment: { type: "compact_file_reference" },
      timestamp: "2026-07-04T01:00:01Z",
    }),
    claudeLine("2026-07-04T01:01:00Z", {
      input_tokens: 20,
      output_tokens: 200,
    }),
  ].join("\n");

  const u = summarizeClaude(text);
  expect(u.compactions).toBe(1);
  expect(u.automaticCompactions).toBe(1);
  expect(u.compactedContextTokens).toBe(999_624);
  expect(u.lastCompactionTs).toBe("2026-07-04T01:00:00Z");
  expect(u.contextTokens).toBe(20);
});

test("summarizeClaude distinguishes manual from automatic compaction", () => {
  const u = summarizeClaude(
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "manual", preTokens: 100_000 },
      timestamp: "2026-07-04T01:00:00Z",
    })
  );
  expect(u.compactions).toBe(1);
  expect(u.automaticCompactions).toBe(0);
});

test("summarizeCodex counts messages by role", () => {
  const text = [
    JSON.stringify({
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "do X" }],
      },
    }),
    JSON.stringify({
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Agent-to-agent pair programming: start this run",
          },
        ],
      },
    }),
    JSON.stringify({
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Claude: bridge review passed" }],
      },
    }),
    JSON.stringify({
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "/compact governess: resume" }],
      },
    }),
    JSON.stringify({
      payload: { type: "message", role: "assistant", content: [] },
    }),
    JSON.stringify({ payload: { type: "reasoning" } }),
    JSON.stringify({ role: "assistant" }),
  ].join("\n");
  const u = summarizeCodex(text);
  expect(u.messages).toBe(2);
  expect(u.humanMessages).toBe(1);
});

test("summarizeCodex counts text, reasoning, and tool activity", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: [] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "exec_command" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "view_image" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "tool_search_call" },
    }),
  ].join("\n");

  const u = summarizeCodex(text);
  expect(u.textMessages).toBe(1);
  expect(u.thinkingMessages).toBe(1);
  expect(u.toolCalls).toBe(3);
  expect(u.toolCallCounts).toEqual({
    exec_command: 1,
    tool_search: 1,
    view_image: 1,
  });
});

test("summarizeCodex uses total_token_usage (cumulative) + last_token_usage (context)", () => {
  const info = (
    totalTotal: number,
    lastInput: number,
    contextWindow?: number
  ) =>
    JSON.stringify({
      payload: {
        info: {
          total_token_usage: {
            cached_input_tokens: totalTotal - 100,
            input_tokens: totalTotal - 50,
            output_tokens: 50,
            total_tokens: totalTotal,
          },
          last_token_usage: {
            cached_input_tokens: lastInput - 1000,
            input_tokens: lastInput,
            output_tokens: 5,
            total_tokens: lastInput + 5,
          },
          ...(contextWindow ? { model_context_window: contextWindow } : {}),
        },
      },
    });
  const u = summarizeCodex(
    [info(1050, 64_000, 258_400), info(2080, 70_000), info(3100, 72_000)].join(
      "\n"
    )
  );
  expect(u.totalTokens).toBe(3100); // largest cumulative total
  expect(u.contextTokens).toBe(72_000); // current context = its last_token_usage input
  expect(u.contextWindow).toBe(258_400);
  expect(u.inputTokens).toBe(50);
  expect(u.cacheReadTokens).toBe(3000);
  expect(u.outputTokens).toBe(50);
});

test("summarizeCodex tracks reasoning effort from turn context", () => {
  const text = [
    JSON.stringify({
      payload: { effort: "medium", model: "gpt-5.5", type: "turn_context" },
      type: "turn_context",
    }),
    JSON.stringify({
      payload: {
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
          },
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
          },
        },
      },
      type: "event_msg",
    }),
  ].join("\n");

  const u = summarizeCodex(text);
  expect(u.reasoningEffort).toBe("medium");
});

test("readAgentUsage falls back to the newest run-scoped rollout when the manifest thread is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-codex-home-stale-"));
  const sessionDir = join(root, "sessions", "2026", "07", "31");
  mkdirSync(sessionDir, { recursive: true });
  const rollout = (totalTokens: number): string =>
    [
      JSON.stringify({
        payload: { effort: "high", model: "gpt-5.6-sol", type: "turn_context" },
        type: "turn_context",
      }),
      JSON.stringify({
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 0,
              input_tokens: totalTokens - 5,
              output_tokens: 5,
              total_tokens: totalTokens,
            },
            last_token_usage: { input_tokens: totalTokens - 5 },
          },
        },
        type: "event_msg",
      }),
    ].join("\n");
  const olderPath = join(
    sessionDir,
    "rollout-2026-07-31T00-00-00-019f-first-spawn.jsonl"
  );
  const newerPath = join(
    sessionDir,
    "rollout-2026-07-31T00-05-00-019f-survivor.jsonl"
  );
  writeFileSync(olderPath, rollout(100), "utf8");
  writeFileSync(newerPath, rollout(4200), "utf8");
  const past = new Date(Date.now() - 60_000);
  utimesSync(olderPath, past, past);

  // The manifest kept a thread id that matches no rollout on disk (run-108
  // failure): a run-scoped home must fall back to its newest rollout instead
  // of reporting "missing" and rendering dashes for every codex stat.
  const stale = readAgentUsage("codex", "019f-thread-nobody-wrote", root);
  expect(stale.totalTokens).toBe(4200);
  expect(stale.model).toBe("gpt-5.6-sol");

  // A matching thread still wins over recency.
  const exact = readAgentUsage("codex", "019f-first-spawn", root);
  expect(exact.totalTokens).toBe(100);
  writeFileSync(
    olderPath,
    JSON.stringify({ type: "session_meta", payload: {} })
  );
  utimesSync(olderPath, past, past);
  const emptyBound = readAgentUsage("codex", "019f-first-spawn", root);
  expect(emptyBound.totalTokens).toBe(4200);
  expect(emptyBound.model).toBe("gpt-5.6-sol");
  expect(emptyBound.dataConfidence).toBe("approx");
});

test("readAgentUsage applies Codex fast history credit multiplier", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-codex-home-"));
  const thread = "019f-fast-test";
  const sessionDir = join(root, "sessions", "2026", "07", "04");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `rollout-2026-07-04T00-00-00-${thread}.jsonl`),
    [
      JSON.stringify({
        payload: { effort: "medium", model: "gpt-5.5", type: "turn_context" },
        type: "turn_context",
      }),
      JSON.stringify({
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 90,
              input_tokens: 100,
              output_tokens: 5,
              total_tokens: 105,
            },
            last_token_usage: { input_tokens: 100 },
          },
        },
        type: "event_msg",
      }),
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "history.jsonl"),
    `${JSON.stringify({ session_id: thread, text: "/fast on" })}\n`,
    "utf8"
  );

  const u = readAgentUsage("codex", thread, root);
  expect(u.speed).toBe("fast");
  expect(u.serviceTier).toBe("fast");
  expect(u.creditCostMultiplier).toBe(2.5);
  expect(u.reasoningEffort).toBe("medium");
});

test("readAgentUsage applies Codex service tier from per-run config", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-codex-home-"));
  const thread = "019f-config-fast-test";
  const sessionDir = join(root, "sessions", "2026", "07", "04");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, "config.toml"), 'service_tier = "fast"\n', "utf8");
  writeFileSync(
    join(sessionDir, `rollout-2026-07-04T00-00-00-${thread}.jsonl`),
    [
      JSON.stringify({
        payload: { effort: "medium", model: "gpt-5.5", type: "turn_context" },
        type: "turn_context",
      }),
      JSON.stringify({
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 90,
              input_tokens: 100,
              output_tokens: 5,
              total_tokens: 105,
            },
            last_token_usage: { input_tokens: 100 },
          },
        },
        type: "event_msg",
      }),
    ].join("\n"),
    "utf8"
  );

  const u = readAgentUsage("codex", thread, root);
  expect(u.serviceTier).toBe("fast");
  expect(u.creditCostMultiplier).toBe(2.5);
  expect(u.reasoningEffort).toBe("medium");
});

test("summarizeCodex counts compactions using the prior context snapshot", () => {
  const info = (totalTotal: number, lastInput: number) =>
    JSON.stringify({
      payload: {
        info: {
          total_token_usage: {
            cached_input_tokens: totalTotal - 100,
            input_tokens: totalTotal - 50,
            output_tokens: 50,
            total_tokens: totalTotal,
          },
          last_token_usage: {
            input_tokens: lastInput,
            output_tokens: 5,
            total_tokens: lastInput + 5,
          },
        },
      },
      type: "event_msg",
    });
  const text = [
    info(1050, 64_000),
    JSON.stringify({
      timestamp: "2026-07-04T00:05:00Z",
      type: "compacted",
      payload: { message: "" },
    }),
    // Codex logs this too, but it is only a notification for the same event.
    JSON.stringify({
      type: "event_msg",
      payload: { type: "context_compacted" },
    }),
    JSON.stringify({
      payload: {
        rate_limits: {
          primary: { used_percent: 70 },
          secondary: { used_percent: 24 },
        },
      },
      type: "event_msg",
    }),
    info(2100, 70_000),
  ].join("\n");

  const u = summarizeCodex(text);
  expect(u.compactions).toBe(1);
  expect(u.compactedContextTokens).toBe(64_000);
  expect(u.dataConfidence).toBe("approx");
  expect(u.lastCompactionTs).toBe("2026-07-04T00:05:00Z");
  expect(u.rateLimitPrimaryPct).toBe(70);
  expect(u.rateLimitSecondaryPct).toBe(24);
  expect(u.contextTokens).toBe(70_000);
});

test("summarizeCodex takes the last token-count event as cumulative usage", () => {
  const text = [
    JSON.stringify({
      payload: { model: "gpt-5.5", model_context_window: 300_000 },
      timestamp: "2026-07-04T00:00:00Z",
    }),
    JSON.stringify({
      payload: {
        info: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:10:00Z",
      payload: {
        info: {
          input_tokens: 4000,
          output_tokens: 300,
          cached_input_tokens: 3900,
          total_tokens: 4300,
        },
      },
    }),
  ].join("\n");
  const u = summarizeCodex(text);
  expect(u.inputTokens).toBe(100);
  expect(u.outputTokens).toBe(300);
  expect(u.cacheReadTokens).toBe(3900);
  expect(u.totalTokens).toBe(4300); // record with the largest total
  expect(u.contextTokens).toBe(0); // codex current context is not exposed
  expect(u.contextWindow).toBe(300_000);
  expect(u.model).toBe("gpt-5.5");
});

test("applyPricing computes cost and context window for a known model", () => {
  // 1M input @ $5, 1M output @ $25 => $30
  const priced = applyPricing({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    compactedContextTokens: 0,
    compactions: 0,
    contextRateTokensPerMinute: 0,
    contextTokens: 500_000,
    contextWindow: 0,
    costRateUsdPerHour: 0,
    costUsd: 0,
    dataConfidence: "exact",
    firstTs: "2026-07-04T00:00:00Z",
    humanMessages: 0,
    messages: 0,
    inputTokens: 1_000_000,
    lastTs: "2026-07-04T01:00:00Z",
    model: "claude-opus-4-8",
    outputTokens: 1_000_000,
    textMessages: 0,
    thinkingMessages: 0,
    toolCalls: 0,
    toolCallCounts: {},
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBeCloseTo(30, 5);
  expect(priced.costRateUsdPerHour).toBeCloseTo(30, 5);
  expect(priced.contextWindow).toBe(1_000_000);
});

test("applyPricing preserves an explicit transcript context window", () => {
  const priced = applyPricing({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    compactedContextTokens: 0,
    compactions: 0,
    contextRateTokensPerMinute: 0,
    contextTokens: 64_000,
    contextWindow: 258_400,
    costRateUsdPerHour: 0,
    costUsd: 0,
    dataConfidence: "exact",
    humanMessages: 0,
    messages: 0,
    inputTokens: 1_000_000,
    model: "gpt-5.5",
    outputTokens: 1_000_000,
    textMessages: 0,
    thinkingMessages: 0,
    toolCalls: 0,
    toolCallCounts: {},
    totalTokens: 2_000_000,
  });
  expect(priced.contextWindow).toBe(258_400);
});

test("applyPricing prices cache tokens at reduced rates", () => {
  // 1M cache-read @ $0.5 + 1M cache-write @ $6.25 = $6.75
  const priced = applyPricing({
    cacheCreateTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    compactedContextTokens: 0,
    compactions: 0,
    contextRateTokensPerMinute: 0,
    contextTokens: 0,
    contextWindow: 0,
    costRateUsdPerHour: 0,
    costUsd: 0,
    dataConfidence: "exact",
    humanMessages: 0,
    messages: 0,
    inputTokens: 0,
    model: "claude-opus-4-8",
    outputTokens: 0,
    textMessages: 0,
    thinkingMessages: 0,
    toolCalls: 0,
    toolCallCounts: {},
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBeCloseTo(6.75, 5);
});

test("applyPricing yields zero cost and default window for an unknown model", () => {
  const priced = applyPricing({
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
    messages: 0,
    inputTokens: 1_000_000,
    model: "some-unknown-model",
    outputTokens: 1_000_000,
    textMessages: 0,
    thinkingMessages: 0,
    toolCalls: 0,
    toolCallCounts: {},
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBe(0);
  expect(priced.contextWindow).toBe(200_000);
});

const routingRow = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    task: "7",
    model: "test/routed",
    prompt_tokens: 1000,
    completion_tokens: 200,
    cached_tokens: 900,
    cache_creation_tokens: 50,
    reasoning_tokens: 180,
    total_tokens: 1200,
    ...overrides,
  });
const routingPrices = {
  data: [
    {
      id: "test/routed",
      pricing: { prompt: "0.000002", completion: "0.000008" },
    },
  ],
};

test("derivation-known-usd: prices tokens once without adding cache/reasoning subsets", () => {
  const priced = deriveRoutingCost(
    parseRoutingUsage(routingRow(), "7"),
    routingPrices
  );
  expect(priced).toHaveLength(1);
  expect(priced[0].costUsd).toBeCloseTo(0.0036, 12);
  expect(priced[0].promptRate).toBe(0.000_002);
  expect(priced[0].completionRate).toBe(0.000_008);
  const twice = deriveRoutingCost(
    parseRoutingUsage(`${routingRow()}\n${routingRow()}`, "7"),
    routingPrices
  );
  expect(twice[0].costUsd).toBeCloseTo(0.0072, 12);
  expect(twice[0].rows).toBe(2);
});

test("unknown-model-closed: missing and duplicate rates name the model", () => {
  const usage = parseRoutingUsage(routingRow(), "7");
  expect(() => deriveRoutingCost(usage, { data: [] })).toThrow(
    "missing price for model test/routed"
  );
  expect(() =>
    deriveRoutingCost(usage, {
      data: [...routingPrices.data, ...routingPrices.data],
    })
  ).toThrow("duplicate price for model test/routed");
  for (const prompt of [
    undefined,
    null,
    "",
    " ",
    "NaN",
    "Infinity",
    -1,
    true,
  ]) {
    expect(() =>
      deriveRoutingCost(usage, {
        data: [{ id: "test/routed", pricing: { prompt, completion: "0.1" } }],
      })
    ).toThrow("pricing.prompt for model test/routed");
  }
});

test("unattributed-excluded: blank/null/missing ownership is counted without charging tokens", () => {
  const usage = parseRoutingUsage(
    [
      routingRow(),
      routingRow({ task: null }),
      routingRow({ task: " " }),
      routingRow({ task: undefined }),
      routingRow({ task: "other" }),
    ].join("\n"),
    "7"
  );
  expect(usage.matchedRows).toBe(1);
  expect(usage.unattributedRows).toBe(3);
  expect(usage.otherTaskRows).toBe(1);
  expect(deriveRoutingCost(usage, routingPrices)[0].costUsd).toBeCloseTo(
    0.0036,
    12
  );
});

test("routing-input-closed: invalid task, tokens, overflow and malformed JSON fail", () => {
  for (const prompt_tokens of [
    -1,
    1.5,
    "100",
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => parseRoutingUsage(routingRow({ prompt_tokens }), "7")).toThrow(
      "prompt_tokens for model test/routed"
    );
  }
  expect(() => parseRoutingUsage(routingRow({ task: 7 }), "7")).toThrow(
    "invalid task identity"
  );
  expect(() => parseRoutingUsage("{", "7")).toThrow("routing line 1");
  expect(() => parseRoutingUsage("[]", "7")).toThrow("expected an object");
  expect(() => parseRoutingUsage(routingRow({ model: "" }), "7")).toThrow(
    "missing routing model"
  );
  expect(() =>
    parseRoutingUsage(
      `${routingRow({ prompt_tokens: Number.MAX_SAFE_INTEGER })}\n${routingRow()}`,
      "7"
    )
  ).toThrow("prompt token sum for model test/routed");
});

test("price-cache-closed: fresh offline prices work; missing, stale, future, and invalid fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-routing-prices-"));
  const path = join(root, "models.json");
  const usage = parseRoutingUsage(routingRow(), "7");
  try {
    await expect(
      priceRoutingUsage(usage, { priceCachePath: path })
    ).rejects.toThrow("model(s) test/routed");
    writeFileSync(path, JSON.stringify(routingPrices));
    const result = await priceRoutingUsage(usage, { priceCachePath: path });
    expect(result.costUsd).toBeCloseTo(0.0036, 12);
    expect(result.priceCache.path).toBe(path);
    expect(result.priceCache.url).toBe("https://openrouter.ai/api/v1/models");
    for (const time of [
      Date.now() - PRICE_CACHE_MAX_AGE_MS - 1000,
      Date.now() + 60_000,
    ]) {
      utimesSync(path, time / 1000, time / 1000);
      await expect(
        priceRoutingUsage(usage, { priceCachePath: path })
      ).rejects.toThrow("missing or stale offline price cache");
    }
    writeFileSync(path, JSON.stringify({ data: [] }));
    utimesSync(path, Date.now() / 1000, Date.now() / 1000);
    await expect(
      priceRoutingUsage(usage, { priceCachePath: path })
    ).rejects.toThrow("missing price for model test/routed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const costFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-cost-report-")));
  const storage = resolveRunStorage("7", root, root);
  const manifest = createRunManifest({
    cwd: root,
    mode: "codex-only",
    pid: process.pid,
    primaryAgent: "codex",
    repoId: storage.repoId,
    runId: "7",
    codexThreadId: "cost-test-thread",
  });
  mkdirSync(storage.runDir, { recursive: true });
  writeRunManifest(storage.manifestPath, manifest);
  const sessions = join(storage.runDir, "codex-home", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "rollout-cost-test-thread.jsonl"),
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-12T01:00:00Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 100,
              output_tokens: 200,
              total_tokens: 1200,
            },
          },
        },
      }),
    ].join("\n")
  );
  const log = join(root, "routing.jsonl");
  const cache = join(root, "models.json");
  writeFileSync(log, routingRow());
  writeFileSync(cache, JSON.stringify(routingPrices));
  const env = {
    LOOP_SWITCHYARD_ROUTING_LOG: log,
    LOOP_OPENROUTER_PRICE_CACHE: cache,
    LOOP_USAGE_TRACKER_LIMITS: "0",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, env);
  return {
    root,
    storage,
    log,
    cache,
    env,
    cleanup: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

test("subscription-source-preserved: actual Codex transcript keeps bundled cost alongside routed cost", async () => {
  const fixture = costFixture();
  try {
    const report = await governessCost("7", fixture.root, fixture.root);
    const seat = report.tasks[0].subscriptions[0];
    expect(seat.source).toBe("governess-usage.ts bundled rate table");
    expect(seat.tokenSource).toContain("Codex rollout via readAgentUsage");
    expect(seat.totalTokens).toBe(1200);
    expect(seat.costUsd).toBeCloseTo(0.010_55, 12);
    expect(report.costUsd).toBeCloseTo(0.014_15, 12);
    expect(report.tasks[0].costUsd).toBe(report.costUsd);
    expect(report.tasks[0].identitySource).toContain("Loop run ID");
    expect(report.status).toBe("complete");
    writeFileSync(fixture.log, routingRow({ task: null }));
    const legacy = await governessCost("7", fixture.root, fixture.root);
    expect(legacy.tasks[0].subscriptions[0].costUsd).toBeCloseTo(0.010_55, 12);
    expect(legacy.costUsd).toBeNull();
    expect(legacy.tasks[0].routed.costUsd).toBeNull();
    expect(legacy.tasks[0].routed.unattributedRows).toBe(1);
    expect(legacy.knownSubtotalUsd).toBeCloseTo(0.010_55, 12);
  } finally {
    fixture.cleanup();
  }
});

test("subscription-tracker-preserved: existing reader applies provider credit estimate", async () => {
  const fixture = costFixture();
  const previous = {
    LOOP_USAGE_TRACKER_URL: process.env.LOOP_USAGE_TRACKER_URL,
    LOOP_USAGE_TRACKER_SECRET: process.env.LOOP_USAGE_TRACKER_SECRET,
  };
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({
        pricing_catalog: {
          codex_credit_usd_estimate: { value: 0.04 },
          rates: [
            {
              provider: "codex",
              model_prefix: "gpt-5.5",
              basis: "credits_per_mtok",
              rates: { input: 2, output: 3, cache_read: 1 },
            },
          ],
        },
      }),
  });
  try {
    process.env.LOOP_USAGE_TRACKER_LIMITS = "1";
    process.env.LOOP_USAGE_TRACKER_URL = server.url.toString();
    process.env.LOOP_USAGE_TRACKER_SECRET = "fixture-secret";
    const report = await governessCost("7", fixture.root, fixture.root);
    expect(report.tasks[0].subscriptions[0].source).toBe("usage-tracker-api");
    expect(report.tasks[0].subscriptions[0].method).toBe("credit-estimate");
    expect(report.tasks[0].subscriptions[0].costUsd).toBeCloseTo(0.0001, 12);
  } finally {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fixture.cleanup();
  }
});

test("subscription-bundled-fallback: a tracker catalog without the model falls back to the labelled bundled table", async () => {
  const fixture = costFixture();
  const previous = {
    LOOP_USAGE_TRACKER_URL: process.env.LOOP_USAGE_TRACKER_URL,
    LOOP_USAGE_TRACKER_SECRET: process.env.LOOP_USAGE_TRACKER_SECRET,
    LOOP_USAGE_TRACKER_LIMITS: process.env.LOOP_USAGE_TRACKER_LIMITS,
  };
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({
        pricing_catalog: {
          codex_credit_usd_estimate: { value: 0.04 },
          rates: [
            {
              provider: "codex",
              model_prefix: "some-other-model",
              basis: "credits_per_mtok",
              rates: { input: 2, output: 3, cache_read: 1 },
            },
          ],
        },
      }),
  });
  try {
    process.env.LOOP_USAGE_TRACKER_LIMITS = "1";
    process.env.LOOP_USAGE_TRACKER_URL = server.url.toString();
    process.env.LOOP_USAGE_TRACKER_SECRET = "fixture-secret";
    const report = await governessCost("7", fixture.root, fixture.root);
    const seat = report.tasks[0].subscriptions[0];
    expect(seat.costUsd).toBeCloseTo(0.010_55, 12);
    expect(seat.source).toContain("bundled rate table");
    expect(seat.source).toContain("catalog lacks this model");
    expect(seat.method).toContain("usage-tracker catalog has no rate for");
    expect(seat.reason).toBeNull();
  } finally {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fixture.cleanup();
  }
});

test("report-closed: missing prices, missing transcript, unowned rows and colliding run IDs stay unknown", async () => {
  const fixture = costFixture();
  try {
    writeFileSync(fixture.cache, JSON.stringify({ data: [] }));
    const unknown = await governessCost("7", fixture.root, fixture.root);
    expect(unknown.costUsd).toBeNull();
    expect(unknown.tasks[0].routed.reason).toContain(
      "missing price for model test/routed"
    );
    writeFileSync(fixture.cache, JSON.stringify(routingPrices));
    writeFileSync(
      fixture.log,
      `${routingRow()}\n${routingRow({ task: null })}`
    );
    const partial = await governessCost("7", fixture.root, fixture.root);
    expect(partial.costUsd).toBeNull();
    expect(partial.tasks[0].routed.knownSubtotalUsd).toBeCloseTo(0.0036, 12);
    expect(partial.tasks[0].routed.unattributedRows).toBe(1);
    mkdirSync(join(fixture.storage.storageRoot, "another-repo", "7"), {
      recursive: true,
    });
    const collision = await governessCost("7", fixture.root, fixture.root);
    expect(collision.tasks[0].routed.knownSubtotalUsd).toBeNull();
    expect(collision.tasks[0].routed.reason).toContain("ambiguous task 7");
    rmSync(join(fixture.storage.runDir, "codex-home"), { recursive: true });
    const noTranscript = await governessCost("7", fixture.root, fixture.root);
    expect(noTranscript.tasks[0].subscriptions[0].costUsd).toBeNull();
    expect(noTranscript.knownSubtotalUsd).toBeNull();
  } finally {
    fixture.cleanup();
  }
});

test("cli-cost-sources: source CLI emits sourced text and JSON and fails closed for legacy run", () => {
  const fixture = costFixture();
  try {
    const run = (args: string[]) =>
      spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "../../src/cli.ts"),
          "governess",
          "cost",
          "7",
          ...args,
        ],
        {
          cwd: fixture.root,
          env: { ...process.env, ...fixture.env, HOME: fixture.root },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        }
      );
    const json = run(["--json"]);
    expect({
      exitCode: json.exitCode,
      stderr: json.stderr.toString(),
      stdout: json.exitCode ? json.stdout.toString() : "",
    }).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const report = JSON.parse(json.stdout.toString());
    expect(report.costUsd).toBeCloseTo(0.014_15, 12);
    expect(report.tasks[0].routed.priceCache.path).toBe(fixture.cache);
    const plain = run([]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).toBe(formatGovernessCost(report));
    expect(plain.stdout.toString()).toContain("USD/token prompt=0.000002");
    writeFileSync(fixture.log, routingRow({ task: null }));
    const legacy = run(["--json"]);
    expect(legacy.exitCode).toBe(1);
    expect(JSON.parse(legacy.stdout.toString()).costUsd).toBeNull();
    const invalid = run(["--extra"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain("Usage: loop governess cost");
  } finally {
    fixture.cleanup();
  }
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPricing,
  readAgentUsage,
  summarizeClaude,
  summarizeCodex,
} from "../../src/loop/governess-usage";

const claudeLine = (
  ts: string,
  usage: Record<string, unknown>,
  model = "claude-opus-4-8"
): string => JSON.stringify({ message: { model, usage }, timestamp: ts });

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
    JSON.stringify({ type: "user", message: { role: "user", content: "do X" } }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "Agent-to-agent pair programming: Codex is the primary agent",
      },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "governess: Codex is at/near session limit" },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "[Request interrupted by user for tool use]" },
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
    JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<reminder>" } }),
    // tool result — not a human prompt
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
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
  expect(u.compactedContextTokens).toBe(999_624);
  expect(u.lastCompactionTs).toBe("2026-07-04T01:00:00Z");
  expect(u.contextTokens).toBe(20);
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
    JSON.stringify({ payload: { type: "message", role: "assistant", content: [] } }),
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
          total_token_usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
          last_token_usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        },
      },
      type: "event_msg",
    }),
  ].join("\n");

  const u = summarizeCodex(text);
  expect(u.reasoningEffort).toBe("medium");
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
    JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
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
    JSON.stringify({ payload: { info: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }),
    JSON.stringify({
      timestamp: "2026-07-04T00:10:00Z",
      payload: { info: { input_tokens: 4000, output_tokens: 300, cached_input_tokens: 3900, total_tokens: 4300 } },
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

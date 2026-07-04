import { expect, test } from "bun:test";
import {
  applyPricing,
  summarizeClaude,
  summarizeCodex,
} from "../../src/loop/babysitter-usage";

const claudeLine = (
  ts: string,
  usage: Record<string, number>,
  model = "claude-opus-4-8"
): string => JSON.stringify({ message: { model, usage }, timestamp: ts });

test("summarizeClaude sums usage across assistant turns and tracks context", () => {
  const text = [
    claudeLine("2026-07-04T00:00:00Z", {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
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
  expect(u.totalTokens).toBe(15 + 300 + 3000 + 50);
  // context ≈ latest turn's input context: 5 + 2000 + 0
  expect(u.contextTokens).toBe(2005);
  expect(u.model).toBe("claude-opus-4-8");
  expect(u.firstTs).toBe("2026-07-04T00:00:00Z");
  expect(u.lastTs).toBe("2026-07-04T00:05:00Z");
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

test("summarizeClaude counts agent messages and genuine human prompts", () => {
  const text = [
    JSON.stringify({ type: "user", message: { role: "user", content: "do X" } }),
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

test("summarizeCodex counts messages by role", () => {
  const text = [
    JSON.stringify({ payload: { type: "message", role: "user", content: [] } }),
    JSON.stringify({ payload: { type: "message", role: "assistant", content: [] } }),
    JSON.stringify({ payload: { type: "reasoning" } }),
    JSON.stringify({ role: "assistant" }),
  ].join("\n");
  const u = summarizeCodex(text);
  expect(u.messages).toBe(2);
  expect(u.humanMessages).toBe(1);
});

test("summarizeCodex takes the last token-count event as cumulative usage", () => {
  const text = [
    JSON.stringify({ model: "gpt-5.5", timestamp: "2026-07-04T00:00:00Z" }),
    JSON.stringify({ payload: { info: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }),
    JSON.stringify({
      timestamp: "2026-07-04T00:10:00Z",
      payload: { info: { input_tokens: 4000, output_tokens: 300, cached_input_tokens: 3900, total_tokens: 4300 } },
    }),
  ].join("\n");
  const u = summarizeCodex(text);
  expect(u.inputTokens).toBe(4000);
  expect(u.outputTokens).toBe(300);
  expect(u.cacheReadTokens).toBe(3900);
  expect(u.totalTokens).toBe(4300); // record with the largest total
  expect(u.contextTokens).toBe(0); // codex current context is not exposed
  expect(u.model).toBe("gpt-5.5");
});

test("applyPricing computes cost and context window for a known model", () => {
  // 1M input @ $5, 1M output @ $25 => $30
  const priced = applyPricing({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 500_000,
    contextWindow: 0,
    costUsd: 0,
    humanMessages: 0,
    messages: 0,
    inputTokens: 1_000_000,
    model: "claude-opus-4-8",
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBeCloseTo(30, 5);
  expect(priced.contextWindow).toBe(1_000_000);
});

test("applyPricing prices cache tokens at reduced rates", () => {
  // 1M cache-read @ $0.5 + 1M cache-write @ $6.25 = $6.75
  const priced = applyPricing({
    cacheCreateTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    humanMessages: 0,
    messages: 0,
    inputTokens: 0,
    model: "claude-opus-4-8",
    outputTokens: 0,
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBeCloseTo(6.75, 5);
});

test("applyPricing yields zero cost and default window for an unknown model", () => {
  const priced = applyPricing({
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    humanMessages: 0,
    messages: 0,
    inputTokens: 1_000_000,
    model: "some-unknown-model",
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
  });
  expect(priced.costUsd).toBe(0);
  expect(priced.contextWindow).toBe(200_000);
});

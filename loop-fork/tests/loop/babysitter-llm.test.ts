import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeAgent } from "../../src/loop/babysitter-llm";
import type { JudgeRequest } from "../../src/loop/types";

const baseRequest = (): JudgeRequest => ({
  agent: "claude",
  hookTail: [
    { agent: "claude", event: "tool", tool: "Bash", ts: "2026-07-04T00:00:00Z" },
  ],
  model: "qwen",
  paneText: "some pane output",
  url: "http://localhost:1234",
});

const chatResponse = (
  content: string,
  status = 200,
  usage?: Record<string, unknown>
): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const stubFetch = (response: Response): typeof fetch =>
  (async () => response) as unknown as typeof fetch;

test("valid strict JSON content yields ok verdict with parsed fields", async () => {
  const content = JSON.stringify({
    state: "waiting-human",
    summary: "awaiting confirmation",
    confidence: 0.8,
    suggestedAction: "prompt user",
  });
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.verdict.state).toBe("waiting-human");
    expect(outcome.verdict.summary).toBe("awaiting confirmation");
    expect(outcome.verdict.confidence).toBe(0.8);
    expect(outcome.verdict.suggestedAction).toBe("prompt user");
  }
});

test("missing usage is estimated from request and response text", async () => {
  const content = JSON.stringify({
    state: "working",
    summary: "still progressing",
    confidence: 0.8,
  });
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });

  expect(outcome.ok).toBe(true);
  if (!outcome.ok || !outcome.usage) {
    throw new Error("expected ok outcome with usage");
  }
  expect(outcome.usage.calls).toBe(1);
  expect(outcome.usage.inputTokens).toBeGreaterThan(0);
  expect(outcome.usage.outputTokens).toBeGreaterThan(0);
  expect(outcome.usage.totalTokens).toBe(
    outcome.usage.inputTokens + outcome.usage.outputTokens
  );
  expect(outcome.tokens).toBe(outcome.usage.totalTokens);
});

test("valid response reports local LLM call and token split", async () => {
  const content = JSON.stringify({
    state: "working",
    summary: "still progressing",
    confidence: 0.8,
  });
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(
      chatResponse(content, 200, {
        completion_tokens: 30,
        prompt_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
        total_tokens: 150,
      })
    ),
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.tokens).toBe(150);
  expect(outcome.usage).toEqual({
    cachedInputTokens: 80,
    calls: 1,
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test("trace file records request and response bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-llm-trace-"));
  const traceFile = join(dir, "llm-trace.jsonl");
  const content = JSON.stringify({
    state: "working",
    summary: "still progressing",
    confidence: 0.8,
  });

  try {
    const outcome = await judgeAgent(
      { ...baseRequest(), traceFile },
      {
        fetchFn: stubFetch(
          chatResponse(content, 200, {
            completion_tokens: 5,
            prompt_tokens: 10,
            total_tokens: 15,
          })
        ),
      }
    );

    expect(outcome.ok).toBe(true);
    const records = readFileSync(traceFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      agent: "claude",
      direction: "to-mlx",
      kind: "llm-trace",
      model: "qwen",
      phase: "request",
      purpose: "judge",
      url: "http://localhost:1234",
    });
    expect(records[0].request.messages[1].content).toContain(
      "some pane output"
    );
    expect(records[1]).toMatchObject({
      callId: records[0].callId,
      direction: "from-mlx",
      kind: "llm-trace",
      ok: true,
      phase: "response",
      status: 200,
      usage: {
        cachedInputTokens: 0,
        calls: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
    expect(records[1].response.choices[0].message.content).toBe(content);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("reasoning content with <think> block is parsed correctly", async () => {
  const content =
    '<think>the agent is looping on the same error</think>\n{"state":"stuck","summary":"stuck in a loop","confidence":0.9}';
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.verdict.state).toBe("stuck");
    expect(outcome.verdict.summary).toBe("stuck in a loop");
    expect(outcome.verdict.confidence).toBe(0.9);
  }
});

test("prose around the JSON object still extracts the verdict", async () => {
  const content =
    'Here is my assessment:\n{"state":"working","summary":"making progress","confidence":0.5}\nHope that helps!';
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.verdict.state).toBe("working");
    expect(outcome.verdict.summary).toBe("making progress");
  }
});

test("confidence out of range is clamped to [0,1]", async () => {
  const content = '{"state":"crashed","summary":"boom","confidence":5}';
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.verdict.confidence).toBe(1);
  }
});

test("non-2xx status returns malformed with fallback", async () => {
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse("{}", 500)),
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("malformed");
    expect(outcome.fallback).toEqual({
      state: "working",
      summary: "",
      confidence: 0,
    });
  }
});

test("network error (ECONNREFUSED) returns unreachable", async () => {
  const fetchFn = (() =>
    Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  const outcome = await judgeAgent(baseRequest(), { fetchFn });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("unreachable");
    expect(outcome.fallback.state).toBe("working");
  }
});

test("AbortError from timeout returns timeout", async () => {
  const fetchFn = (() =>
    Promise.reject(
      new DOMException("Aborted", "AbortError")
    )) as unknown as typeof fetch;
  const outcome = await judgeAgent(baseRequest(), { fetchFn, timeoutMs: 10 });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("timeout");
  }
});

test("invalid state value returns malformed", async () => {
  const content = '{"state":"napping","summary":"zzz","confidence":0.4}';
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse(content)),
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("malformed");
  }
});

test("empty content returns malformed", async () => {
  const outcome = await judgeAgent(baseRequest(), {
    fetchFn: stubFetch(chatResponse("")),
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("malformed");
  }
});

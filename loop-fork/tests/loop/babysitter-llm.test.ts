import { expect, test } from "bun:test";
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

const chatResponse = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
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
  const fetchFn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const outcome = await judgeAgent(baseRequest(), { fetchFn });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("unreachable");
    expect(outcome.fallback.state).toBe("working");
  }
});

test("AbortError from timeout returns timeout", async () => {
  const fetchFn = (async () => {
    const err = new DOMException("Aborted", "AbortError");
    throw err;
  }) as unknown as typeof fetch;
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

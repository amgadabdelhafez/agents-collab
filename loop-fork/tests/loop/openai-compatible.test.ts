import { expect, test } from "bun:test";
import {
  extractOpenAICompatibleUsage,
  type OpenAICompatibleChatRequest,
  type OpenAICompatibleTraceEvent,
  openAICompatibleChat,
} from "../../src/loop/openai-compatible";

const baseRequest = (): OpenAICompatibleChatRequest => ({
  endpoint: "https://openrouter.example/api/v1/chat/completions",
  maxRetries: 0,
  messages: [{ content: "Inspect this file", role: "user" }],
  model: "z-ai/glm-5.2",
});

const response = (
  payload: unknown,
  status = 200,
  headers?: HeadersInit
): Response =>
  new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });

test("sends bearer auth, tools, and a non-streaming wire-compatible conversation", async () => {
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const request: OpenAICompatibleChatRequest = {
    ...baseRequest(),
    apiKey: "openrouter-secret",
    maxTokens: 300,
    messages: [
      { content: "Use repository tools", role: "system" },
      { content: "Read src/a.ts", role: "user" },
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: '{"path":"src/a.ts"}', name: "read_file" },
            id: "call-1",
            type: "function",
          },
        ],
      },
      {
        content: "export const value = 1;",
        role: "tool",
        tool_call_id: "call-1",
      },
    ],
    provider: { sort: "exacto" },
    temperature: 0,
    toolChoice: "auto",
    tools: [
      {
        function: {
          description: "Read an allowed file",
          name: "read_file",
          parameters: {
            properties: { path: { type: "string" } },
            required: ["path"],
            type: "object",
          },
        },
        type: "function",
      },
    ],
  };

  const result = await openAICompatibleChat(request, {
    fetchFn: ((url, init) => {
      sentUrl = String(url);
      sentInit = init;
      return Promise.resolve(
        response({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: '{"path":"src/b.ts"}',
                      name: "read_file",
                    },
                    id: "call-2",
                    type: "function",
                  },
                ],
              },
            },
          ],
          id: "generation-1",
          model: "z-ai/glm-5.2",
        })
      );
    }) as typeof fetch,
  });

  expect(sentUrl).toBe(request.endpoint);
  expect(new Headers(sentInit?.headers).get("Authorization")).toBe(
    "Bearer openrouter-secret"
  );
  const body = JSON.parse(String(sentInit?.body));
  expect(body).toMatchObject({
    max_tokens: 300,
    messages: request.messages,
    model: "z-ai/glm-5.2",
    provider: { sort: "exacto" },
    stream: false,
    temperature: 0,
    tool_choice: "auto",
    tools: request.tools,
  });
  expect(result).toMatchObject({
    attempts: 1,
    finishReason: "tool_calls",
    id: "generation-1",
    message: {
      content: null,
      tool_calls: [{ id: "call-2", type: "function" }],
    },
    ok: true,
  });
});

test("omits authorization when no API key is configured", async () => {
  let headers = new Headers();
  const result = await openAICompatibleChat(baseRequest(), {
    fetchFn: ((_url, init) => {
      headers = new Headers(init?.headers);
      return Promise.resolve(
        response({
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
        })
      );
    }) as typeof fetch,
  });

  expect(headers.has("Authorization")).toBe(false);
  expect(result.ok).toBe(true);
});

test("extracts token details and OpenRouter cost fields", async () => {
  const payload = {
    choices: [{ finish_reason: "stop", message: { content: "done" } }],
    usage: {
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 4 },
      cost: 0.001_25,
      cost_details: { upstream_inference_cost: 0.0009 },
      prompt_tokens: 21,
      prompt_tokens_details: { cached_tokens: 8 },
      total_tokens: 30,
    },
  };

  expect(extractOpenAICompatibleUsage(payload)).toEqual({
    cachedInputTokens: 8,
    cost: 0.001_25,
    inputTokens: 21,
    outputTokens: 9,
    reasoningTokens: 4,
    totalTokens: 30,
    upstreamInferenceCost: 0.0009,
  });
  const result = await openAICompatibleChat(baseRequest(), {
    fetchFn: (async () => response(payload)) as typeof fetch,
  });
  expect(result.usage.cost).toBe(0.001_25);
  expect(result.usage.reasoningTokens).toBe(4);
});

test("retries 429 and 5xx with Retry-After or exponential backoff", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await openAICompatibleChat(
    {
      ...baseRequest(),
      maxRetries: 2,
      retryBaseDelayMs: 75,
    },
    {
      fetchFn: (() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            response({ error: { message: "busy" } }, 429, {
              "Retry-After": "2",
            })
          );
        }
        if (calls === 2) {
          return Promise.resolve(
            response({ error: { message: "upstream" } }, 503)
          );
        }
        return Promise.resolve(
          response({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
          })
        );
      }) as typeof fetch,
      sleep: (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    }
  );

  expect(calls).toBe(3);
  expect(delays).toEqual([2000, 150]);
  expect(result).toMatchObject({ attempts: 3, ok: true });
});

test("returns a structured HTTP error after bounded retries", async () => {
  let calls = 0;
  const result = await openAICompatibleChat(
    { ...baseRequest(), maxRetries: 1, retryBaseDelayMs: 0 },
    {
      fetchFn: (() => {
        calls += 1;
        return Promise.resolve(
          response(
            {
              error: { message: "provider overloaded" },
              usage: { completion_tokens: 1, prompt_tokens: 2 },
            },
            500
          )
        );
      }) as typeof fetch,
      sleep: () => Promise.resolve(),
    }
  );

  expect(calls).toBe(2);
  expect(result).toMatchObject({
    attempts: 2,
    error: {
      kind: "http",
      message: "provider overloaded",
      retryable: true,
      status: 500,
    },
    ok: false,
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  });
});

test("does not retry ordinary 4xx responses", async () => {
  let calls = 0;
  const result = await openAICompatibleChat(
    { ...baseRequest(), maxRetries: 3 },
    {
      fetchFn: (() => {
        calls += 1;
        return Promise.resolve(
          response({ error: { message: "bad request" } }, 400)
        );
      }) as typeof fetch,
    }
  );

  expect(calls).toBe(1);
  expect(result).toMatchObject({
    error: { kind: "http", retryable: false, status: 400 },
    ok: false,
  });
});

test("times out a slow attempt with a structured error", async () => {
  const result = await openAICompatibleChat(
    { ...baseRequest(), timeoutMs: 5 },
    {
      fetchFn: ((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as typeof fetch,
    }
  );

  expect(result).toMatchObject({
    attempts: 1,
    error: { kind: "timeout", retryable: false },
    ok: false,
  });
});

test("returns structured network and invalid-response errors", async () => {
  const network = await openAICompatibleChat(baseRequest(), {
    fetchFn: (() =>
      Promise.reject(new Error("connection refused"))) as typeof fetch,
  });
  expect(network).toMatchObject({
    error: { kind: "network", message: "connection refused" },
    ok: false,
  });

  const malformed = await openAICompatibleChat(baseRequest(), {
    fetchFn: (async () => new Response("not json")) as typeof fetch,
  });
  expect(malformed).toMatchObject({
    error: { kind: "invalid-response" },
    ok: false,
  });
});

test("trace hook redacts credentials in URLs, bodies, responses, and errors", async () => {
  const secret = "sk-or-v1-super-secret";
  const events: OpenAICompatibleTraceEvent[] = [];
  const request: OpenAICompatibleChatRequest = {
    ...baseRequest(),
    apiKey: secret,
    endpoint: `https://user:${secret}@example.test/chat?api_key=${secret}`,
    messages: [
      {
        content: `accidental credential: ${secret}; Authorization: Bearer ${secret}`,
        role: "user",
      },
    ],
    onTrace: (event) => {
      events.push(event);
      throw new Error(`trace failure must be ignored: ${secret}`);
    },
  };

  const result = await openAICompatibleChat(request, {
    fetchFn: (async () =>
      response(
        { error: { api_key: secret, message: `rejected ${secret}` } },
        401
      )) as typeof fetch,
  });

  expect(result.ok).toBe(false);
  expect(events.length).toBeGreaterThan(0);
  const traceText = JSON.stringify(events);
  expect(traceText).not.toContain(secret);
  expect(traceText).toContain("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain(secret);
});

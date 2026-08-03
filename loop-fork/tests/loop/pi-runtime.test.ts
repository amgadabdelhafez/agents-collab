import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Server, serve } from "bun";
import {
  completePiText,
  createEphemeralPiAgent,
  createPiSessionRuntime,
  PI_VERSION,
} from "../../src/loop/pi-runtime";

const servers: Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const chunk = (
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>
): string =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: "chatcmpl-loop-test",
    model: "fake-model",
    object: "chat.completion.chunk",
    ...(usage ? { usage } : {}),
  })}\n\n`;

const sse = (parts: string[]): Response =>
  new Response(`${parts.join("")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });

const fakeProvider = (
  responder: (body: Record<string, unknown>, call: number) => Response
): { endpoint: string; requests: Record<string, unknown>[] } => {
  const requests: Record<string, unknown>[] = [];
  const server = serve({
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      return responder(body, requests.length);
    },
    port: 0,
  });
  servers.push(server);
  return {
    endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    requests,
  };
};

describe("shared Pi runtime", () => {
  test("registers Nanny with bounded output and explicit thinking controls", async () => {
    const runtime = await createPiSessionRuntime({
      endpoint: "http://127.0.0.1:8082/v1/chat/completions",
      model: "fake-nanny",
      provider: "nanny",
    });
    expect(runtime.model).toMatchObject({
      maxTokens: 3200,
      reasoning: true,
    });
    expect(runtime.model.compat).toMatchObject({
      thinkingFormat: "qwen-chat-template",
    });
  });

  test("resolves the Au Pair through Pi's OpenRouter catalog without network refresh", async () => {
    const runtime = await createPiSessionRuntime({
      apiKey: "test-only-key",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "z-ai/glm-5.2",
      provider: "au-pair",
      providerSort: "exacto",
    });
    expect(runtime.providerId).toBe("openrouter");
    expect(runtime.model).toMatchObject({
      api: "openai-completions",
      id: "z-ai/glm-5.2",
      provider: "openrouter",
    });
    expect(
      (runtime.model.compat as { openRouterRouting?: { sort?: string } })
        .openRouterRouting?.sort
    ).toBe("exacto");
  });

  test("runs a no-tools Nanny completion with normalized usage", async () => {
    const provider = fakeProvider(() =>
      sse([
        chunk({ role: "assistant" }),
        chunk({ content: "NANNY_OK" }),
        chunk({}, "stop", {
          completion_tokens: 3,
          prompt_tokens: 7,
          total_tokens: 10,
        }),
      ])
    );
    const result = await completePiText({
      maxTokens: 100,
      provider: {
        endpoint: provider.endpoint,
        model: "fake-model",
        provider: "nanny",
      },
      systemPrompt: "Return a marker.",
      temperature: 0,
      timeoutMs: 5000,
      userPrompt: "Confirm.",
    });
    expect(result).toMatchObject({
      piVersion: PI_VERSION,
      stopReason: "stop",
      text: "NANNY_OK",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
      max_tokens: 100,
      model: "fake-model",
      stream: true,
    });
  });

  test("runs an Au Pair completion through the same Pi runtime", async () => {
    const provider = fakeProvider(() =>
      sse([
        chunk({ role: "assistant" }),
        chunk({ content: "AU_PAIR_OK" }),
        chunk({}, "stop", {
          completion_tokens: 4,
          prompt_tokens: 6,
          total_tokens: 10,
        }),
      ])
    );
    const result = await completePiText({
      maxTokens: 100,
      provider: {
        apiKey: "test-only-key",
        endpoint: provider.endpoint,
        model: "fake-glm",
        provider: "au-pair",
      },
      systemPrompt: "Return a marker.",
      temperature: 0,
      timeoutMs: 5000,
      userPrompt: "Confirm.",
    });

    expect(result).toMatchObject({
      piVersion: PI_VERSION,
      text: "AU_PAIR_OK",
      usage: { totalTokens: 10 },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).not.toHaveProperty("chat_template_kwargs");
  });

  test("exposes only the explicit custom tool and completes a tool turn", async () => {
    const provider = fakeProvider((_body, call) =>
      call === 1
        ? sse([
            chunk({ role: "assistant" }),
            chunk({
              tool_calls: [
                {
                  function: {
                    arguments: '{"value":"PI_TOOL_OK"}',
                    name: "echo_value",
                  },
                  id: "call-1",
                  index: 0,
                  type: "function",
                },
              ],
            }),
            chunk({}, "tool_calls", {
              completion_tokens: 8,
              prompt_tokens: 10,
              total_tokens: 18,
            }),
          ])
        : sse([
            chunk({ role: "assistant" }),
            chunk({ content: "done" }),
            chunk({}, "stop", {
              completion_tokens: 2,
              prompt_tokens: 20,
              total_tokens: 22,
            }),
          ])
    );
    let toolCalls = 0;
    const tool = defineTool({
      description: "Return a supplied value.",
      execute: (_id, args) => {
        toolCalls += 1;
        return Promise.resolve({
          content: [{ text: args.value, type: "text" }],
          details: { value: args.value },
        });
      },
      executionMode: "sequential",
      label: "echo_value",
      name: "echo_value",
      parameters: Type.Object({ value: Type.String() }),
    });
    const created = await createEphemeralPiAgent({
      cwd: process.cwd(),
      provider: {
        endpoint: provider.endpoint,
        model: "fake-model",
        provider: "nanny",
      },
      systemPrompt: "Use the one available tool, then finish.",
      tools: [tool],
    });
    let finalText = "";
    created.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalText = event.message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("");
      }
    });
    expect(created.activeToolNames).toEqual(["echo_value"]);
    expect(created.session.getActiveToolNames()).not.toEqual(
      expect.arrayContaining(["bash", "read", "edit", "write"])
    );
    await created.session.prompt("Call echo_value.", {
      expandPromptTemplates: false,
      source: "rpc",
    });
    await created.session.waitForIdle();
    created.session.dispose();
    expect(toolCalls).toBe(1);
    expect(finalText).toBe("done");
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      expect(request).toMatchObject({
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: true,
        },
      });
    }
    expect(JSON.stringify(provider.requests[1])).toContain("PI_TOOL_OK");
  });
});

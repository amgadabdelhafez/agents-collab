import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server, serve } from "bun";
import { PI_VERSION } from "../../src/loop/pi-runtime";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import { runUtilityWorker } from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const servers: Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const event = (
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>
): string =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: "chatcmpl-utility-pi",
    model: "fake-nanny",
    object: "chat.completion.chunk",
    ...(usage ? { usage } : {}),
  })}\n\n`;

const response = (events: string[]): Response =>
  new Response(`${events.join("")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });

test("Nanny executes a brokered Pi tool turn with durable evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-nanny-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-nanny");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const needle = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    executionProfile: "search",
    id: "pi-nanny-job",
    kind: "inspect",
    objective: "Find the declared needle",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 91);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 91,
  });

  const bodies: Record<string, unknown>[] = [];
  const server = serve({
    fetch: async (incoming) => {
      bodies.push((await incoming.json()) as Record<string, unknown>);
      return bodies.length === 1
        ? response([
            event({ role: "assistant" }),
            event({
              tool_calls: [
                {
                  function: {
                    arguments: '{"query":"needle","paths":["src"]}',
                    name: "search_repo",
                  },
                  id: "search-1",
                  index: 0,
                  type: "function",
                },
              ],
            }),
            event({}, "tool_calls", {
              completion_tokens: 8,
              prompt_tokens: 40,
              total_tokens: 48,
            }),
          ])
        : response([
            event({ role: "assistant" }),
            event({ content: "Needle found in src/sample.ts." }),
            event({}, "stop", {
              completion_tokens: 7,
              prompt_tokens: 70,
              total_tokens: 77,
            }),
          ]);
    },
    port: 0,
  });
  servers.push(server);

  try {
    await runUtilityWorker(runDir, 91, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Needle found in src/sample.ts.",
      },
      state: "completed",
    });
    expect(bodies).toHaveLength(2);
    const firstTools = JSON.stringify(bodies[0]?.tools);
    expect(firstTools).toContain("search_repo");
    expect(firstTools).not.toContain('"bash"');
    expect(firstTools).not.toContain('"read"');
    expect(firstTools).not.toContain('"write"');
    expect(firstTools).not.toContain('"edit"');
    expect(JSON.stringify(bodies[1])).toContain("src/sample.ts");

    const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
    expect(usage).toContain('"harness":"pi-sdk"');
    expect(usage).toContain('"tierId":"utility-nanny"');
    expect(usage).toContain(`"piVersion":"${PI_VERSION}"`);
    expect(usage).toContain('"role":"Nanny"');
    expect(usage).toContain('"toolCalls":1');
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"tool":"search_repo"');
    expect(
      readFileSync(join(runDir, "utility", "llm-trace.jsonl"), "utf8")
    ).toContain('"harness":"pi-sdk"');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi counts a rejected sibling batch as one model round and can adapt", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-rejection-round-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-rejection-round");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const needle = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    executionProfile: "search",
    id: "pi-rejection-round-job",
    kind: "inspect",
    objective: "Find needle after adapting from a rejected path batch",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 95);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 95,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [1, 2, 3].map((index) => ({
              function: {
                arguments: JSON.stringify({
                  paths: [`outside-${index}`],
                  query: "needle",
                }),
                name: "search_repo",
              },
              id: `rejected-${index}`,
              index: index - 1,
              type: "function",
            })),
          }),
          event({}, "tool_calls"),
        ]);
      }
      if (providerCalls === 2) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [
              {
                function: {
                  arguments: '{"query":"needle","paths":["src"]}',
                  name: "search_repo",
                },
                id: "adapted-search",
                index: 0,
                type: "function",
              },
            ],
          }),
          event({}, "tool_calls"),
        ]);
      }
      return response([
        event({ role: "assistant" }),
        event({ content: "Adapted and found needle in src/sample.ts." }),
        event({}, "stop"),
      ]);
    },
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 95, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(providerCalls).toBe(3);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Adapted and found needle in src/sample.ts.",
      },
      state: "completed",
    });
    const toolEvents = readFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      "utf8"
    );
    expect(toolEvents.match(/"ok":false/g)).toHaveLength(3);
    expect(toolEvents).toContain('"code":"scope_denied"');
    expect(toolEvents).toContain('"ok":true');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi fails after three rejected model rounds with exact broker evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-rejection-limit-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-rejection-limit");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const value = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return bounded evidence"],
    authority: {},
    executionProfile: "search",
    id: "pi-rejection-limit-job",
    kind: "inspect",
    objective: "Search only the declared source scope",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 96);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 96,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return response([
        event({ role: "assistant" }),
        event({
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  paths: [`outside-${providerCalls}`],
                  query: "value",
                }),
                name: "search_repo",
              },
              id: `rejected-round-${providerCalls}`,
              index: 0,
              type: "function",
            },
          ],
        }),
        event({}, "tool_calls"),
      ]);
    },
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 96, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(providerCalls).toBe(3);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: expect.stringContaining(
          "3 consecutive broker-rejected model rounds without progress (last error: scope_denied from search_repo:"
        ),
        status: "failed",
      },
      state: "failed",
    });
    expect(readUtilityJob(runDir, request.id)?.result?.blocker).toContain(
      "Path is outside declared read scope: outside-3"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Direct exact reads produce evidence without contacting a model", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-direct-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-direct");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const exact = 7;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return the exact line"],
    authority: {},
    executionProfile: "file-read",
    executionRead: { endLine: 1, path: "src/sample.ts", startLine: 1 },
    id: "pi-direct-job",
    kind: "inspect",
    objective: "Read the exact declared line",
    readScope: ["src/sample.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 92);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-direct",
    },
    routeEpoch: 92,
  });
  try {
    await runUtilityWorker(runDir, 92, request.id, {
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: expect.stringContaining("export const exact = 7"),
      },
      state: "completed",
    });
    const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
    expect(usage).toContain('"harness":"direct"');
    expect(usage).toContain('"modelCalls":0');
    expect(usage).toContain('"model":"none"');
    expect(usage).toContain('"tierId":"utility-direct"');
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"tool":"read_file"');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi stops an oversized sibling tool batch before broker execution", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-batch-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-batch");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const value = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return bounded evidence"],
    authority: {},
    executionProfile: "search",
    id: "pi-batch-job",
    kind: "inspect",
    objective: "Search the bounded source",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 93);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 93,
  });
  const server = serve({
    fetch: () =>
      response([
        event({ role: "assistant" }),
        event({
          tool_calls: Array.from({ length: 13 }, (_, index) => ({
            function: {
              arguments: JSON.stringify({ query: `value-${index}` }),
              name: "search_repo",
            },
            id: `search-${index}`,
            index,
            type: "function",
          })),
        }),
        event({}, "tool_calls", {
          completion_tokens: 100,
          prompt_tokens: 40,
          total_tokens: 140,
        }),
      ]),
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 93, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
      LOOP_UTILITY_MAX_SIBLING_TOOL_CALLS: "12",
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: expect.stringContaining("13-call sibling batch exceeded 12"),
        status: "failed",
      },
      state: "failed",
    });
    expect(() =>
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toThrow();
    const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
    expect(usage).toContain('"status":"failed"');
    expect(usage).toContain('"provider":"loop-nanny"');
    expect(usage).toContain(`"piVersion":"${PI_VERSION}"`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi refuses broker work after durable cancellation", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-cancel-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-cancel");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const value = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return bounded evidence"],
    authority: {},
    executionProfile: "search",
    id: "pi-cancel-job",
    kind: "inspect",
    objective: "Search the bounded source",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 94);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 94,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      transitionUtilityJob(runDir, request.id, "canceled", {
        reason: "test cancellation",
      });
      return response([
        event({ role: "assistant" }),
        event({
          tool_calls: [
            {
              function: {
                arguments: '{"query":"value","paths":["src"]}',
                name: "search_repo",
              },
              id: "search-after-cancel",
              index: 0,
              type: "function",
            },
          ],
        }),
        event({}, "tool_calls", {
          completion_tokens: 8,
          prompt_tokens: 40,
          total_tokens: 48,
        }),
      ]);
    },
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 94, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(readUtilityJob(runDir, request.id)?.state).toBe("canceled");
    expect(providerCalls).toBe(1);
    expect(() =>
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toThrow();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

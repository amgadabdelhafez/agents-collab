import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
  retainUtilityScopeAuditCollection,
  runUtilityWorker,
} from "../../src/loop/utility-runtime";
import { buildUtilityScopeAuditEvidence } from "../../src/loop/utility-scope-audit";
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

test("D16 utility scope audit preserves routing-hidden Git paths when synthesis reports only visible paths", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-d16-scope-audit-"));
  const runDir = join(repoRoot, ".loop", "runs", "d16-scope-audit");
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout;
  };
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, "specs", "d16-fixture"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, ".gitignore"), ".loop/\n");
  writeFileSync(
    join(repoRoot, "src", "tracked.ts"),
    "export const tracked = 1;\n"
  );
  git("init", "--quiet");
  git("config", "user.email", "d16@example.test");
  git("config", "user.name", "D16 Fixture");
  git("add", "--", ".gitignore", "src/tracked.ts");
  git("commit", "--quiet", "-m", "fixture base");
  writeFileSync(
    join(repoRoot, "src", "tracked.ts"),
    "export const tracked = 2;\n"
  );
  writeFileSync(
    join(repoRoot, "specs", "d16-fixture", "spec.md"),
    "# routing-hidden scope evidence\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["report every Git-derived changed path"],
    authority: {},
    executionProfile: "git-status",
    id: "d16-scope-audit-job",
    kind: "review",
    objective: "Audit every changed path in the declared repository scope",
    readScope: ["."],
    requester: "codex",
    reviewMode: "utility-audit",
    requiredCapabilities: ["inspect"],
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 116);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 116,
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
                  function: { arguments: "{}", name: "git_status" },
                  id: "d16-git-status",
                  index: 0,
                  type: "function",
                },
              ],
            }),
            event({}, "tool_calls"),
          ])
        : response([
            event({ role: "assistant" }),
            event({
              content:
                "Audit complete: one modified path, src/tracked.ts; no other changed paths.",
            }),
            event({}, "stop"),
          ]);
    },
    port: 0,
  });
  servers.push(server);

  try {
    expect(git("status", "--porcelain=v1", "--untracked-files=normal")).toBe(
      [" M src/tracked.ts", "?? specs/", ""].join("\n")
    );
    await runUtilityWorker(runDir, 116, request.id, {
      LOOP_AU_PAIR_ENABLED: "1",
      LOOP_AU_PAIR_MODEL: "fake-au-pair",
      LOOP_AU_PAIR_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain("src/tracked.ts");
    expect(JSON.stringify(bodies[1])).not.toContain(
      "specs/d16-fixture/spec.md"
    );
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        scopeAudit: {
          manifests: [
            {
              clean: false,
              count: 2,
              records: expect.arrayContaining([
                expect.objectContaining({
                  path: "specs/d16-fixture/spec.md",
                }),
                expect.objectContaining({ path: "src/tracked.ts" }),
              ]),
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
          ],
        },
        status: "completed",
      },
      state: "completed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("D16 runtime retains equal query bytes, rejects conflict, and keeps distinct queries", () => {
  const evidence = buildUtilityScopeAuditEvidence(
    { mode: "status", paths: ["src"] },
    [
      {
        indexStatus: ".",
        kind: "modified",
        path: "src/tracked.ts",
        routing: "helper-visible",
        surfaces: ["worktree"],
        worktreeStatus: "M",
      },
    ]
  );
  const result = {
    durationMs: 1,
    ok: true as const,
    scopeAudit: evidence,
    tool: "git_status" as const,
  };
  const first = retainUtilityScopeAuditCollection(undefined, result);
  expect(retainUtilityScopeAuditCollection(first, result)).toEqual(first);

  const conflict = buildUtilityScopeAuditEvidence(
    { mode: "status", paths: ["src"] },
    [
      {
        indexStatus: ".",
        kind: "deleted",
        path: "src/tracked.ts",
        routing: "helper-visible",
        surfaces: ["worktree"],
        worktreeStatus: "D",
      },
    ]
  );
  expect(() =>
    retainUtilityScopeAuditCollection(first, {
      ...result,
      scopeAudit: conflict,
    })
  ).toThrow("scope audit broker results conflict for one query");

  const distinct = retainUtilityScopeAuditCollection(first, {
    durationMs: 1,
    ok: true,
    scopeAudit: buildUtilityScopeAuditEvidence(
      { mode: "diff-worktree", paths: ["src"] },
      []
    ),
    tool: "git_diff",
  });
  expect(distinct?.manifests).toHaveLength(2);
});

test("D16 Direct distinct ranges coexist with deterministic completion state", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-scope-ranges-"));
  const runDir = join(repoRoot, ".loop", "runs", "scope-ranges");
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout.trim();
  };
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  git("init", "--quiet");
  git("config", "user.email", "d16@example.test");
  git("config", "user.name", "D16 Fixture");
  writeFileSync(join(repoRoot, "src", "tracked.ts"), "export const v = 1;\n");
  git("add", "--", "src/tracked.ts");
  git("commit", "--quiet", "-m", "fixture base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "src", "tracked.ts"), "export const v = 2;\n");
  git("commit", "--all", "--quiet", "-m", "fixture middle");
  const middle = git("rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "src", "tracked.ts"), "export const v = 3;\n");
  git("commit", "--all", "--quiet", "-m", "fixture head");
  const head = git("rev-parse", "HEAD");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["retain both exact range manifests"],
    authority: {},
    executionPlan: [middle, head].map((rangeHead) => ({
      executionGitDiff: {
        base,
        head: rangeHead,
        kind: "range" as const,
        operator: "..." as const,
      },
      executionProfile: "git-diff" as const,
      objective: `Inspect range ending ${rangeHead}`,
      readScope: ["src"],
    })),
    executionProfile: "read-plan",
    id: "scope-distinct-ranges",
    kind: "inspect",
    objective: "Inspect two exact committed ranges",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 118);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-direct",
    },
    routeEpoch: 118,
  });

  try {
    await runUtilityWorker(runDir, 118, request.id, {
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    const job = readUtilityJob(runDir, request.id);
    const manifests = job?.result?.scopeAudit?.manifests ?? [];
    expect(job?.state).toBe("completed");
    expect(job?.result?.status).toBe("completed");
    expect(manifests).toHaveLength(2);
    const expectedQueries = [middle, head].map((rangeHead) => ({
      baseRef: base,
      headRef: rangeHead,
      mode: "diff-range" as const,
      paths: ["src"],
      rangeOperator: "..." as const,
    }));
    expectedQueries.sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      if (leftJson < rightJson) {
        return -1;
      }
      if (leftJson > rightJson) {
        return 1;
      }
      return 0;
    });
    expect(manifests.map((manifest) => manifest.query)).toEqual(
      expectedQueries
    );
    const bridgeEvents = readFileSync(join(runDir, "bridge.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completion = bridgeEvents.find(
      (entry) => entry.kind === "message" && entry.taskId === request.id
    );
    const expectedState = manifests
      .map(
        (manifest) =>
          `mode=${manifest.query.mode} count=${manifest.count} clean=${manifest.clean} sha256=${manifest.sha256}`
      )
      .join(" | ");
    expect(completion?.message).toStartWith(expectedState);
    expect(completion?.message).toContain("Advisory synthesis:");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("D16 Direct mixed command validates Git evidence before completion", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-scope-command-"));
  const runDir = join(repoRoot, ".loop", "runs", "scope-command");
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  };
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "check.js"), "export const value = 1;\n");
  git("init", "--quiet");
  git("config", "user.email", "d16@example.test");
  git("config", "user.name", "D16 Fixture");
  git("add", "--", "src/check.js");
  git("commit", "--quiet", "-m", "fixture base");
  writeFileSync(join(repoRoot, "src", "check.js"), "export const value = 2;\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return Git evidence and a passing syntax check"],
    authority: {},
    executionPlan: [
      {
        executionProfile: "git-status",
        objective: "Inspect repository status",
        readScope: ["."],
      },
      {
        executionArgv: ["node", "--check", "src/check.js"],
        executionCwd: ".",
        executionProfile: "focused-check",
        objective: "Check exact JavaScript syntax",
        readScope: [".", "src/check.js"],
      },
    ],
    executionProfile: "read-plan",
    id: "scope-mixed-command",
    kind: "command",
    objective: "Inspect and verify exact scope",
    readScope: [".", "src/check.js"],
    requester: "codex",
    requiredCapabilities: ["inspect", "focused-verify"],
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 119);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-direct",
    },
    routeEpoch: 119,
  });

  try {
    await runUtilityWorker(runDir, 119, request.id, {
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    const job = readUtilityJob(runDir, request.id);
    expect(job?.state).toBe("completed");
    expect(job?.result?.checks).toEqual([
      {
        command: ["allowlisted-check"],
        exitCode: 0,
        summary: "check completed",
      },
    ]);
    expect(job?.result?.scopeAudit?.manifests[0]?.query).toEqual({
      mode: "status",
      paths: ["."],
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Au Pair recovers from searching an exact declared new file and proposes it", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-au-pair-new-file-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-au-pair-new-file");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "reference.ts"),
    "export const ref = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["propose one exact new-file patch"],
    authority: {},
    id: "pi-au-pair-new-file-job",
    kind: "edit",
    objective: "Create the exact declared file",
    readScope: ["src/reference.ts", "src/new.ts"],
    requester: "codex",
    requiredCapabilities: ["inspect", "scoped-edit"],
    risk: "low",
    writeScope: ["src/new.ts"],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 101);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 101,
  });

  const bodies: Record<string, unknown>[] = [];
  const patch = [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+export const created = true;",
    "",
  ].join("\n");
  const server = serve({
    fetch: async (incoming) => {
      bodies.push((await incoming.json()) as Record<string, unknown>);
      if (bodies.length === 1) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [
              {
                function: {
                  arguments: '{"query":"export","paths":["src/new.ts"]}',
                  name: "search_repo",
                },
                id: "search-new-file",
                index: 0,
                type: "function",
              },
            ],
          }),
          event({}, "tool_calls"),
        ]);
      }
      if (bodies.length === 2) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({
                    patch,
                    summary: "create exact declared file",
                  }),
                  name: "propose_patch",
                },
                id: "propose-new-file",
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
        event({ content: "Proposed src/new.ts after confirming it is new." }),
        event({}, "stop"),
      ]);
    },
    port: 0,
  });
  servers.push(server);

  try {
    await runUtilityWorker(runDir, 101, request.id, {
      LOOP_AU_PAIR_ENABLED: "1",
      LOOP_AU_PAIR_MODEL: "fake-au-pair",
      LOOP_AU_PAIR_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    const job = readUtilityJob(runDir, request.id);
    const artifactPath = job?.result?.artifactRefs[0]?.path;
    expect(job).toMatchObject({
      result: {
        artifactRefs: [
          {
            kind: "diff",
            path: expect.stringContaining(".patch"),
          },
        ],
        status: "completed",
      },
      state: "completed",
    });
    expect(bodies).toHaveLength(3);
    const firstMessages = bodies[0]?.messages as Array<{
      content: Array<{ text: string }> | string;
    }>;
    const capsuleText = (
      firstMessages[1]?.content as Array<{ text: string }>
    )[0]?.text;
    expect(JSON.parse(capsuleText ?? "{}")).toMatchObject({
      writeTargets: [{ path: "src/new.ts", state: "new" }],
    });
    expect(JSON.stringify(bodies[0])).toContain(
      "new-file diff using --- /dev/null"
    );
    expect(JSON.stringify(bodies[1])).toContain('\\"data\\":[]');
    expect(() => readFileSync(join(repoRoot, "src", "new.ts"))).toThrow();
    expect(typeof artifactPath).toBe("string");
    if (typeof artifactPath !== "string") {
      throw new Error("missing new-file patch artifact path");
    }
    expect(readFileSync(artifactPath, "utf8")).toBe(patch);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi forces synthesis before the hard tool ceiling", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-synthesis-reserve-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-synthesis-reserve");
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
    id: "pi-synthesis-reserve-job",
    kind: "inspect",
    objective: "Inspect the bounded source and finish before the hard ceiling",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 98);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 98,
  });
  const bodies: Record<string, unknown>[] = [];
  let requestedSearches = 0;
  const server = serve({
    fetch: async (incoming) => {
      const body = (await incoming.json()) as Record<string, unknown>;
      bodies.push(body);
      const availableTools = Array.isArray(body.tools) ? body.tools : [];
      if (availableTools.length === 0) {
        return response([
          event({ role: "assistant" }),
          event({ content: "Synthesized the bounded evidence before cutoff." }),
          event({}, "stop"),
        ]);
      }
      const siblingCount = bodies.length === 2 ? 3 : 1;
      const firstSearch = requestedSearches + 1;
      requestedSearches += siblingCount;
      return response([
        event({ role: "assistant" }),
        event({
          tool_calls: Array.from({ length: siblingCount }, (_, index) => {
            const searchNumber = firstSearch + index;
            return {
              function: {
                arguments: JSON.stringify({
                  paths: ["src"],
                  query: `needle-${searchNumber}`,
                }),
                name: "search_repo",
              },
              id: `search-${searchNumber}`,
              index,
              type: "function",
            };
          }),
        }),
        event({}, "tool_calls"),
      ]);
    },
    port: 0,
  });
  servers.push(server);

  try {
    await runUtilityWorker(runDir, 98, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
      LOOP_UTILITY_MAX_TOOL_CALLS: "4",
    });
    expect(requestedSearches).toBe(4);
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies.at(-1))).toContain("FINALIZE_NOW");
    expect(bodies.at(-1)?.tools ?? []).toEqual([]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Synthesized the bounded evidence before cutoff.",
      },
      state: "completed",
    });
    const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
    expect(usage).toContain('"toolCalls":3');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Pi preserves every required structured-plan call at the configured ceiling", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-plan-ceiling-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-plan-ceiling");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const paths = Array.from({ length: 4 }, (_, index) =>
    join("src", `sample-${index + 1}.ts`)
  );
  for (const [index, path] of paths.entries()) {
    writeFileSync(join(repoRoot, path), `export const value = ${index + 1};\n`);
  }
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return all four exact reads"],
    authority: {},
    executionPlan: paths.map((path, index) => ({
      executionProfile: "file-read" as const,
      executionRead: { endLine: 1, path, startLine: 1 },
      objective: `Read exact file ${index + 1}`,
      readScope: [path],
    })),
    executionProfile: "read-plan",
    id: "pi-plan-ceiling-job",
    kind: "inspect",
    objective: "Execute every required bounded read-plan step",
    readScope: paths,
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 99);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 99,
  });
  const bodies: Record<string, unknown>[] = [];
  let requestedReads = 0;
  const server = serve({
    fetch: async (incoming) => {
      const body = (await incoming.json()) as Record<string, unknown>;
      bodies.push(body);
      const availableTools = Array.isArray(body.tools) ? body.tools : [];
      if (availableTools.length === 0) {
        return response([
          event({ role: "assistant" }),
          event({ content: "Completed every exact read-plan step." }),
          event({}, "stop"),
        ]);
      }
      const path = paths[requestedReads];
      requestedReads += 1;
      return response([
        event({ role: "assistant" }),
        event({
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  endLine: 1,
                  path,
                  startLine: 1,
                }),
                name: "read_file",
              },
              id: `read-${requestedReads}`,
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
    await runUtilityWorker(runDir, 99, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
      LOOP_UTILITY_MAX_TOOL_CALLS: "4",
    });
    expect(requestedReads).toBe(4);
    expect(bodies).toHaveLength(5);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Completed every exact read-plan step.",
      },
      state: "completed",
    });
    const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
    expect(usage).toContain('"toolCalls":4');
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

test("Pi receives a safely narrowed 500-line read and continues at the next line", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-range-adaptation-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-range-adaptation");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "many-lines.txt"),
    `${Array.from({ length: 600 }, (_, index) => `line-${index + 1}`).join("\n")}\n`
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    id: "pi-range-adaptation-job",
    kind: "inspect",
    objective: "Read bounded evidence after correcting one oversized range",
    readScope: ["src/many-lines.txt"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 97);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 97,
  });
  const bodies: Record<string, unknown>[] = [];
  const server = serve({
    fetch: async (incoming) => {
      bodies.push((await incoming.json()) as Record<string, unknown>);
      if (bodies.length === 1) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [
              {
                function: {
                  arguments:
                    '{"path":"src/many-lines.txt","startLine":1,"endLine":600}',
                  name: "read_file",
                },
                id: "oversized-read",
                index: 0,
                type: "function",
              },
            ],
          }),
          event({}, "tool_calls"),
        ]);
      }
      if (bodies.length === 2) {
        return response([
          event({ role: "assistant" }),
          event({
            tool_calls: [
              {
                function: {
                  arguments:
                    '{"path":"src/many-lines.txt","startLine":501,"endLine":600}',
                  name: "read_file",
                },
                id: "bounded-read",
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
        event({ content: "Corrected the range and read bounded evidence." }),
        event({}, "stop"),
      ]);
    },
    port: 0,
  });
  servers.push(server);

  try {
    await runUtilityWorker(runDir, 97, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(bodies).toHaveLength(3);
    const secondMessages = bodies[1]?.messages;
    expect(Array.isArray(secondMessages)).toBe(true);
    const toolMessage = (secondMessages as Record<string, unknown>[]).find(
      (message) => message.role === "tool"
    );
    const toolResult = JSON.parse(String(toolMessage?.content));
    expect(toolResult).toMatchObject({
      data: {
        endLine: 500,
        nextStartLine: 501,
        requestedEndLine: 600,
        truncated: true,
      },
      ok: true,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Corrected the range and read bounded evidence.",
      },
      state: "completed",
    });
    const toolEvents = readFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      "utf8"
    );
    expect(toolEvents).not.toContain('"ok":false');
    expect(toolEvents.match(/"ok":true/g)).toHaveLength(2);
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

test("Pi accepts a fifteen-call sibling audit with the default limit", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-pi-default-batch-"));
  const runDir = join(repoRoot, ".loop", "runs", "pi-default-batch");
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
    id: "pi-default-batch-job",
    kind: "inspect",
    objective: "Audit fifteen bounded search terms",
    readScope: ["src"],
    requester: "codex",
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
      tierId: "utility-au-pair",
    },
    routeEpoch: 92,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      if (providerCalls > 1) {
        return response([
          event({ role: "assistant" }),
          event({ content: "Completed all fifteen bounded searches." }),
          event({}, "stop"),
        ]);
      }
      return response([
        event({ role: "assistant" }),
        event({
          tool_calls: Array.from({ length: 15 }, (_, index) => ({
            function: {
              arguments: JSON.stringify({ query: `value-${index}` }),
              name: "search_repo",
            },
            id: `search-${index}`,
            index,
            type: "function",
          })),
        }),
        event({}, "tool_calls"),
      ]);
    },
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 92, request.id, {
      LOOP_AU_PAIR_ENABLED: "1",
      LOOP_AU_PAIR_MODEL: "fake-au-pair",
      LOOP_AU_PAIR_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(providerCalls).toBe(2);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        status: "completed",
        summary: "Completed all fifteen bounded searches.",
      },
      state: "completed",
    });
    const events = readFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      "utf8"
    );
    expect(events.split("\n").filter(Boolean)).toHaveLength(15);
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

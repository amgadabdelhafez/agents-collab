import { describe, expect, test } from "bun:test";
import {
  createUtilityRouteRequest,
  routeUtilityRequest,
  type UtilityRouteContext,
  type UtilityRouteReason,
  type UtilityRouteRequest,
  type UtilityRouteRequestInput,
} from "../../src/loop/task-router";

const requestInput = (
  overrides: Partial<UtilityRouteRequestInput> = {}
): UtilityRouteRequestInput => ({
  acceptanceCriteria: ["The focused check passes"],
  authority: {},
  kind: "edit",
  objective: "Make the bounded parser change",
  readScope: ["src/parser.ts", "tests/parser.test.ts"],
  requester: "codex",
  requiredCapabilities: ["scoped-edit", "focused-verify"],
  risk: "low",
  writeScope: ["src/parser.ts", "tests/parser.test.ts"],
  ...overrides,
});

const context = (
  overrides: Partial<UtilityRouteContext> = {}
): UtilityRouteContext => ({
  activeWriteClaims: [],
  currentDriver: "codex",
  currentEpoch: 7,
  peer: "claude",
  tiers: [
    {
      capabilities: [
        "inspect",
        "bounded-command",
        "scoped-edit",
        "focused-verify",
      ],
      enabled: true,
      healthy: true,
      id: "cheap-oss",
      model: "z-ai/glm-5.2",
      provider: "openrouter",
    },
  ],
  ...overrides,
});

const makeRequest = (overrides: Partial<UtilityRouteRequestInput> = {}) =>
  createUtilityRouteRequest(requestInput(overrides), {
    now: () => "2026-07-25T10:00:00.000Z",
    randomId: () => "job-1",
  });

test("routes a bounded low-risk edit to a capable utility tier", () => {
  expect(routeUtilityRequest(makeRequest(), context())).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
});

test("routing is provider generic", () => {
  const decision = routeUtilityRequest(
    makeRequest({
      kind: "inspect",
      requiredCapabilities: ["inspect"],
      writeScope: [],
    }),
    context({
      tiers: [
        {
          capabilities: ["inspect"],
          enabled: true,
          healthy: true,
          id: "local-small",
          model: "local-model",
          provider: "localhost",
        },
      ],
    })
  );

  expect(decision).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "local-small",
  });
});

test("applies generic tier patterns and an eligible default fallback", () => {
  const decision = routeUtilityRequest(
    makeRequest(),
    context({
      routingPolicy: {
        allowedTierPatterns: ["oss-*"],
        costQualityTradeoff: 6,
        defaultFallbackTierId: "oss-fallback",
        preventPerRequestOverrides: true,
        selectionStrategy: "tool-call-quality",
      },
      tiers: [
        {
          capabilities: ["scoped-edit", "focused-verify"],
          enabled: true,
          healthy: true,
          id: "premium-frontier",
        },
        {
          capabilities: ["scoped-edit", "focused-verify"],
          enabled: true,
          healthy: true,
          id: "oss-primary",
        },
        {
          capabilities: ["scoped-edit", "focused-verify"],
          enabled: true,
          healthy: true,
          id: "oss-fallback",
        },
      ],
    })
  );

  expect(decision.tierId).toBe("oss-fallback");
});

test("cost-quality policy changes which eligible tier wins", () => {
  const tiers = [
    {
      affordabilityScore: 0.1,
      capabilities: ["scoped-edit", "focused-verify"] as const,
      enabled: true,
      healthy: true,
      id: "high-quality",
      qualityScore: 1,
    },
    {
      affordabilityScore: 1,
      capabilities: ["scoped-edit", "focused-verify"] as const,
      enabled: true,
      healthy: true,
      id: "low-cost",
      qualityScore: 0.4,
    },
  ];
  expect(
    routeUtilityRequest(
      makeRequest(),
      context({ routingPolicy: { costQualityTradeoff: 0 }, tiers })
    ).tierId
  ).toBe("high-quality");
  expect(
    routeUtilityRequest(
      makeRequest(),
      context({ routingPolicy: { costQualityTradeoff: 10 }, tiers })
    ).tierId
  ).toBe("low-cost");
});

test("fails closed on invalid generic routing policy metadata", () => {
  expect(
    routeUtilityRequest(
      makeRequest(),
      context({ routingPolicy: { costQualityTradeoff: 11 } })
    )
  ).toEqual({ reason: "routing-policy-invalid", target: "driver" });
});

test("routes review to the peer and authority to escalation", () => {
  expect(
    routeUtilityRequest(makeRequest({ kind: "review" }), context())
  ).toEqual({ reason: "review-needs-peer", target: "peer" });
  expect(
    routeUtilityRequest(
      makeRequest({ kind: "review", requester: "claude" }),
      context()
    )
  ).toEqual({
    reason: "review-stays-with-requester",
    target: "requester",
  });
  expect(
    routeUtilityRequest(makeRequest({ kind: "design" }), context())
  ).toEqual({ reason: "authority-needs-human", target: "escalate" });
});

describe("fail-closed gates", () => {
  test.each([
    [
      "missing epoch",
      {},
      { currentEpoch: undefined },
      "missing-governess-epoch",
    ],
    [
      "missing acceptance",
      { acceptanceCriteria: [] },
      {},
      "request-not-bounded",
    ],
    ["unknown risk", { risk: "unknown" }, {}, "risk-not-low"],
    ["protected path", { writeScope: [".env"] }, {}, "protected-scope"],
    [
      "credential directory",
      { readScope: [".aws/config"] },
      {},
      "protected-scope",
    ],
    [
      "agent settings",
      { readScope: ["src/../.claude/settings.json"] },
      {},
      "protected-scope",
    ],
    [
      "nested credential directory",
      { readScope: ["packages/api/.aws/config"] },
      {},
      "protected-scope",
    ],
    [
      "nested governing spec",
      { readScope: ["packages/api/specs/auth/spec.md"] },
      {},
      "protected-scope",
    ],
    [
      "nested architecture",
      { readScope: ["packages/api/docs/architecture/invariants.md"] },
      {},
      "protected-scope",
    ],
    [
      "copilot instructions",
      { readScope: [".github/copilot-instructions.md"] },
      {},
      "protected-scope",
    ],
    [
      "case-varied nested agent settings",
      { readScope: ["packages/api/.CURSOR/rules/project.mdc"] },
      {},
      "protected-scope",
    ],
    ["write conflict", {}, { activeWriteClaims: ["src"] }, "write-conflict"],
    [
      "missing capability",
      {},
      {
        tiers: [{ capabilities: [], enabled: true, healthy: true, id: "tiny" }],
      },
      "capability-unavailable",
    ],
    [
      "unhealthy tier",
      {},
      {
        tiers: [
          {
            capabilities: ["scoped-edit", "focused-verify"],
            enabled: true,
            healthy: false,
            id: "tiny",
          },
        ],
      },
      "utility-unavailable",
    ],
  ])("keeps %s with the driver", (_label, request, routeContext, reason) => {
    expect(
      routeUtilityRequest(
        makeRequest(request as Partial<UtilityRouteRequestInput>),
        context(routeContext as Partial<UtilityRouteContext>)
      )
    ).toEqual({ reason: reason as UtilityRouteReason, target: "driver" });
  });

  test.each([
    "credentialAccess",
    "dependencyChange",
    "destructive",
    "migration",
    "productDecision",
    "remoteMutation",
    "release",
  ] as const)("escalates forbidden %s authority", (flag) => {
    expect(
      routeUtilityRequest(
        makeRequest({ authority: { [flag]: true } }),
        context()
      )
    ).toEqual({ reason: "forbidden-authority", target: "escalate" });
  });

  test("cost estimates do not gate routing", () => {
    expect(
      routeUtilityRequest(makeRequest({ estimatedCostUsd: 10_000 }), context())
    ).toEqual({
      reason: "utility-eligible",
      target: "utility",
      tierId: "cheap-oss",
    });
  });
});

test("normalizes requests and creates a stable idempotency key", () => {
  const normalizedInput = requestInput({
    acceptanceCriteria: ["done"],
    executionCwd: "packages/api",
    objective: "bounded work",
    readScope: ["src/parser.ts"],
  });
  const first = createUtilityRouteRequest(
    requestInput({
      acceptanceCriteria: [" done ", "done"],
      executionCwd: "./packages/api/",
      objective: " bounded work ",
      readScope: ["./src/parser.ts"],
    }),
    { now: () => "one", randomId: () => "first" }
  );
  const second = createUtilityRouteRequest(normalizedInput, {
    now: () => "two",
    randomId: () => "second",
  });

  expect(first.objective).toBe("bounded work");
  expect(first.acceptanceCriteria).toEqual(["done"]);
  expect(first.executionCwd).toBe("packages/api");
  expect(first.readScope[0]).toBe("src/parser.ts");
  expect(first.idempotencyKey).toBe(second.idempotencyKey);
});

test("normalizes context refs and includes them in idempotency", () => {
  const first = createUtilityRouteRequest(
    requestInput({
      contextRefs: [" ./docs/guide.md ", "docs/guide.md", "README.md"],
    }),
    { now: () => "one", randomId: () => "first" }
  );
  const same = createUtilityRouteRequest(
    requestInput({ contextRefs: ["docs/guide.md", "README.md"] }),
    { now: () => "two", randomId: () => "second" }
  );
  const different = createUtilityRouteRequest(
    requestInput({ contextRefs: ["docs/other.md"] }),
    { now: () => "three", randomId: () => "third" }
  );

  expect(first.contextRefs).toEqual(["docs/guide.md", "README.md"]);
  expect(first.idempotencyKey).toBe(same.idempotencyKey);
  expect(first.idempotencyKey).not.toBe(different.idempotencyKey);
  expect(
    createUtilityRouteRequest(requestInput({ contextRefs: [" "] }), {
      now: () => "four",
      randomId: () => "fourth",
    }).idempotencyKey
  ).toBe(
    createUtilityRouteRequest(requestInput(), {
      now: () => "five",
      randomId: () => "fifth",
    }).idempotencyKey
  );
});

test("fails closed on invalid or excessive context refs", () => {
  for (const contextRefs of [
    ["../README.md"],
    ["docs/../README.md"],
    ["AGENTS.md"],
    ["UTILITY.instructions.md"],
    ["src/parser.ts"],
    Array.from({ length: 7 }, (_, index) => `docs/${index}.md`),
  ]) {
    expect(
      routeUtilityRequest(makeRequest({ contextRefs }), context())
    ).toEqual({ reason: "request-not-bounded", target: "driver" });
  }
  expect(
    routeUtilityRequest(
      makeRequest({ contextRefs: ["specs/router/spec.md"] }),
      context()
    )
  ).toMatchObject({ reason: "utility-eligible", target: "utility" });
});

test("treats a protected execution cwd as protected scope", () => {
  expect(
    routeUtilityRequest(
      makeRequest({ executionCwd: ".claude", kind: "command" }),
      context()
    )
  ).toEqual({ reason: "protected-scope", target: "driver" });
});

test("routes a fully structured focused check", () => {
  expect(
    routeUtilityRequest(
      makeRequest({
        executionArgv: ["bun", "test", "tests/parser.test.ts"],
        executionCwd: ".",
        executionProfile: "focused-check",
        kind: "command",
        readScope: [".", "tests/parser.test.ts"],
        requiredCapabilities: ["bounded-command", "focused-verify"],
        writeScope: [],
      }),
      context()
    )
  ).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
});

test("routes only an exactly bounded file-read profile", () => {
  expect(
    routeUtilityRequest(
      makeRequest({
        executionProfile: "file-read",
        executionRead: {
          endLine: 40,
          path: "src/parser.ts",
          startLine: 1,
        },
        kind: "inspect",
        readScope: ["src/parser.ts"],
        requiredCapabilities: ["inspect"],
        writeScope: [],
      }),
      context()
    )
  ).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
});

test("routes a bounded read-plan profile without command or write authority", () => {
  expect(
    routeUtilityRequest(
      makeRequest({
        executionPlan: [
          {
            executionProfile: "search",
            objective: "Search source",
            readScope: ["src"],
          },
          {
            executionProfile: "file-list",
            objective: "List tests",
            readScope: ["tests"],
          },
        ],
        executionProfile: "read-plan",
        kind: "inspect",
        readScope: ["src", "tests"],
        requiredCapabilities: ["inspect"],
        writeScope: [],
      }),
      context()
    )
  ).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
});

test("routes a mixed structured plan with one exact focused-check stage", () => {
  const request = makeRequest({
    executionPlan: [
      {
        executionProfile: "git-status",
        objective: "Inspect status",
        readScope: ["."],
      },
      {
        executionArgv: ["bun", "test", "tests/router.test.ts"],
        executionCwd: ".",
        executionProfile: "focused-check",
        objective: "Run the focused router test",
        readScope: [".", "tests/router.test.ts"],
      },
    ],
    executionProfile: "read-plan",
    kind: "command",
    objective: "Inspect status and run the exact focused test",
    readScope: [".", "tests/router.test.ts"],
    requiredCapabilities: ["inspect", "bounded-command", "focused-verify"],
    writeScope: [],
  });
  expect(routeUtilityRequest(request, context())).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
  expect(request.executionPlan?.[1]).toMatchObject({
    executionArgv: ["bun", "test", "tests/router.test.ts"],
    executionCwd: ".",
  });
});

test.each([
  {
    executionArgv: ["bun", "test", "tests/router.test.ts"],
    executionProfile: "focused-check" as const,
    objective: "Missing cwd",
    readScope: [".", "tests/router.test.ts"],
  },
  {
    executionArgv: ["bun", "test", "../outside.test.ts"],
    executionCwd: ".",
    executionProfile: "focused-check" as const,
    objective: "Outside scope",
    readScope: [".", "tests/router.test.ts"],
  },
  {
    executionArgv: ["git", "commit", "-am", "nope"],
    executionCwd: ".",
    executionProfile: "focused-check" as const,
    objective: "Mutation",
    readScope: ["."],
  },
])("rejects malformed or unsafe focused-check plan stage", (stage) => {
  expect(
    routeUtilityRequest(
      makeRequest({
        executionPlan: [stage],
        executionProfile: "read-plan",
        kind: "command",
        readScope: stage.readScope,
        requiredCapabilities: ["bounded-command", "focused-verify"],
        writeScope: [],
      }),
      context()
    )
  ).toEqual({ reason: "request-not-bounded", target: "driver" });
});

test.each([
  makeRequest({ executionProfile: "read-plan", kind: "inspect" }),
  makeRequest({ executionProfile: "git-inspect", kind: "inspect" }),
  makeRequest({
    executionGit: { action: "resolve-ref", ref: "HEAD..main" },
    executionProfile: "git-inspect",
    kind: "inspect",
    readScope: ["."],
  }),
  makeRequest({
    executionGit: {
      action: "log",
      limit: 51,
    },
    executionProfile: "git-inspect",
    kind: "inspect",
    readScope: ["."],
  }),
  makeRequest({
    executionPlan: [
      {
        executionProfile: "search",
        objective: "Search source",
        readScope: ["src"],
      },
    ],
    executionProfile: "read-plan",
    kind: "inspect",
    readScope: ["src", "tests"],
    writeScope: [],
  }),
  makeRequest({
    executionPlan: [
      {
        executionProfile: "file-read",
        executionRead: {
          endLine: 10,
          path: "tests/example.ts",
          startLine: 1,
        },
        objective: "Read source",
        readScope: ["src/example.ts"],
      },
    ],
    executionProfile: "read-plan",
    kind: "inspect",
    readScope: ["src/example.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionPlan: [
      {
        executionProfile: "git-inspect",
        executionGit: { action: "worktree-list" },
        objective: "Inspect Git metadata",
        readScope: ["src/example.ts"],
      },
    ],
    executionProfile: "read-plan",
    kind: "inspect",
    readScope: ["src/example.ts"],
    writeScope: [],
  }),
])("keeps malformed structured read plans with the driver", (request) => {
  expect(routeUtilityRequest(request, context())).toEqual({
    reason: "request-not-bounded",
    target: "driver",
  });
});

test("routes a structurally exact Git inspection", () => {
  expect(
    routeUtilityRequest(
      makeRequest({
        executionGit: { action: "log", limit: 3, ref: "HEAD" },
        executionProfile: "git-inspect",
        kind: "inspect",
        readScope: ["."],
        writeScope: [],
      }),
      context()
    )
  ).toEqual({
    reason: "utility-eligible",
    target: "utility",
    tierId: "cheap-oss",
  });
});

test("normalizes and routes a structured output boundary", () => {
  const request = makeRequest({
    executionOutput: { lineLimit: 25, position: "tail", stderr: "merge" },
    executionProfile: "search",
    kind: "inspect",
    readScope: ["src/parser.ts"],
    requiredCapabilities: ["inspect"],
    writeScope: [],
  });
  expect(request.executionOutput).toEqual({
    lineLimit: 25,
    position: "tail",
    stderr: "merge",
  });
  expect(routeUtilityRequest(request, context())).toMatchObject({
    reason: "utility-eligible",
    target: "utility",
  });
});

test.each([
  makeRequest({ executionProfile: "focused-check", kind: "command" }),
  makeRequest({
    executionProfile: "file-read",
    kind: "inspect",
    writeScope: [],
  }),
  makeRequest({
    executionOutput: { lineLimit: 501, position: "head" },
    executionProfile: "search",
    kind: "inspect",
    readScope: ["src/parser.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionOutput: { lineLimit: 20 },
    executionProfile: "search",
    kind: "inspect",
    readScope: ["src/parser.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionProfile: "file-read",
    executionRead: { endLine: 501, path: "src/parser.ts", startLine: 1 },
    kind: "inspect",
    readScope: ["src/parser.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionProfile: "file-read",
    executionRead: { lastLines: 20, path: "src/other.ts" },
    kind: "inspect",
    readScope: ["src/parser.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionProfile: "search",
    executionRead: { lastLines: 20, path: "src/parser.ts" },
    kind: "inspect",
    readScope: ["src/parser.ts"],
    writeScope: [],
  }),
  makeRequest({
    executionCwd: ".",
    executionProfile: "focused-check",
    kind: "command",
  }),
  makeRequest({
    executionArgv: [
      "bun",
      "test",
      "tests/1.test.ts",
      "tests/2.test.ts",
      "tests/3.test.ts",
      "tests/4.test.ts",
      "tests/5.test.ts",
    ],
    executionCwd: ".",
    executionProfile: "focused-check",
    kind: "command",
    readScope: [
      ".",
      "tests/1.test.ts",
      "tests/2.test.ts",
      "tests/3.test.ts",
      "tests/4.test.ts",
      "tests/5.test.ts",
    ],
    writeScope: [],
  }),
  {
    ...makeRequest({
      executionCwd: ".",
      executionProfile: "focused-check",
      kind: "command",
    }),
    executionCwd: 42 as unknown as string,
  },
  makeRequest({
    executionCwd: ".",
    executionProfile:
      "future-profile" as UtilityRouteRequest["executionProfile"],
    kind: "command",
  }),
])("keeps malformed persisted execution metadata with the driver", (request) => {
  expect(routeUtilityRequest(request, context())).toEqual({
    reason: "request-not-bounded",
    target: "driver",
  });
});

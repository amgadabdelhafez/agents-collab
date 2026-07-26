import { describe, expect, test } from "bun:test";
import {
  createUtilityRouteRequest,
  routeUtilityRequest,
  type UtilityRouteContext,
  type UtilityRouteReason,
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

  test("rejects an over-budget route", () => {
    expect(
      routeUtilityRequest(
        makeRequest({ estimatedCostUsd: 0.2 }),
        context({ remainingRunBudgetUsd: 0.1 })
      )
    ).toEqual({ reason: "budget-exceeded", target: "driver" });
  });

  test("reserves the tier maximum when a request omits its estimate", () => {
    expect(
      routeUtilityRequest(
        makeRequest(),
        context({
          remainingRunBudgetUsd: 0.04,
          tiers: [
            {
              capabilities: ["scoped-edit", "focused-verify"],
              enabled: true,
              healthy: true,
              id: "cheap-oss",
              maxJobCostUsd: 0.05,
            },
          ],
        })
      )
    ).toEqual({ reason: "budget-exceeded", target: "driver" });
  });
});

test("normalizes requests and creates a stable idempotency key", () => {
  const normalizedInput = requestInput({
    acceptanceCriteria: ["done"],
    objective: "bounded work",
    readScope: ["src/parser.ts"],
  });
  const first = createUtilityRouteRequest(
    requestInput({
      acceptanceCriteria: [" done ", "done"],
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
  expect(first.readScope[0]).toBe("src/parser.ts");
  expect(first.idempotencyKey).toBe(second.idempotencyKey);
});

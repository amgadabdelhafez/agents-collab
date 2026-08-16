import { describe, expect, test } from "bun:test";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  classifyUtilityExecution,
  directUtilityCalls,
  UTILITY_AU_PAIR_TIER,
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
} from "../../src/loop/utility-execution-tier";

const inspectRequest = (
  overrides: Partial<Parameters<typeof createUtilityRouteRequest>[0]> = {}
) =>
  createUtilityRouteRequest({
    acceptanceCriteria: ["return repository evidence"],
    authority: {},
    kind: "inspect",
    objective: "Inspect the declared scope",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
    ...overrides,
  });

describe("utility execution tier classification", () => {
  test("exact file reads bypass every model", () => {
    const request = inspectRequest({
      executionProfile: "file-read",
      executionRead: { endLine: 20, path: "src/example.ts", startLine: 10 },
      readScope: ["src/example.ts"],
    });
    expect(classifyUtilityExecution(request)).toBe(UTILITY_DIRECT_TIER);
    expect(directUtilityCalls(request)).toEqual([
      {
        arguments: {
          endLine: 20,
          path: "src/example.ts",
          startLine: 10,
        },
        name: "read_file",
      },
    ]);
  });

  test("exact focused checks bypass every model", () => {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["the focused test passes"],
      authority: {},
      executionArgv: ["bun", "test", "tests/unit.test.ts"],
      executionCwd: ".",
      executionProfile: "focused-check",
      kind: "command",
      objective: "Run one focused test",
      readScope: [".", "tests/unit.test.ts"],
      requester: "codex",
      requiredCapabilities: ["focused-verify"],
      risk: "low",
      writeScope: [],
    });
    expect(classifyUtilityExecution(request)).toBe(UTILITY_DIRECT_TIER);
    expect(directUtilityCalls(request)?.[0]).toEqual({
      arguments: {
        argv: ["bun", "test", "tests/unit.test.ts"],
        cwd: ".",
      },
      name: "run_check",
    });
  });

  test("exact Git inspections bypass every model", () => {
    const request = inspectRequest({
      executionGit: { action: "log", limit: 3, ref: "HEAD" },
      executionProfile: "git-inspect",
      readScope: ["."],
    });
    expect(classifyUtilityExecution(request)).toBe(UTILITY_DIRECT_TIER);
    expect(directUtilityCalls(request)).toEqual([
      {
        arguments: { action: "log", limit: 3, ref: "HEAD" },
        name: "git_inspect",
      },
    ]);
  });

  test("fully exact mixed plans bypass every model", () => {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["return status and focused test evidence"],
      authority: {},
      executionPlan: [
        {
          executionGit: { action: "worktree-list" },
          executionProfile: "git-inspect",
          objective: "List registered worktrees",
          readScope: ["."],
        },
        {
          executionProfile: "git-status",
          objective: "Inspect status",
          readScope: ["."],
        },
        {
          executionArgv: ["bun", "test", "tests/unit.test.ts"],
          executionCwd: ".",
          executionProfile: "focused-check",
          objective: "Run focused test",
          readScope: [".", "tests/unit.test.ts"],
        },
      ],
      executionProfile: "read-plan",
      kind: "command",
      objective: "Inspect and verify",
      readScope: [".", "tests/unit.test.ts"],
      requester: "codex",
      requiredCapabilities: ["inspect", "bounded-command", "focused-verify"],
      risk: "low",
      writeScope: [],
    });
    expect(classifyUtilityExecution(request)).toBe(UTILITY_DIRECT_TIER);
    expect(directUtilityCalls(request)).toEqual([
      { arguments: { action: "worktree-list" }, name: "git_inspect" },
      { arguments: {}, name: "git_status" },
      {
        arguments: {
          argv: ["bun", "test", "tests/unit.test.ts"],
          cwd: ".",
        },
        name: "run_check",
      },
    ]);
  });

  test("Direct Git-diff plans preserve explicit worktree, index, and range selection", () => {
    const base = "1".repeat(40);
    const head = "2".repeat(40);
    const request = inspectRequest({
      executionPlan: [
        {
          executionGitDiff: { kind: "worktree" },
          executionProfile: "git-diff",
          objective: "Inspect worktree changes",
          readScope: ["src"],
        },
        {
          executionGitDiff: { kind: "index" },
          executionProfile: "git-diff",
          objective: "Inspect index changes",
          readScope: ["tests"],
        },
        {
          executionGitDiff: { base, head, kind: "range", operator: "..." },
          executionProfile: "git-diff",
          objective: "Inspect committed changes",
          readScope: ["docs"],
        },
      ],
      executionProfile: "read-plan",
      readScope: ["src", "tests", "docs"],
    });

    expect(classifyUtilityExecution(request)).toBe(UTILITY_DIRECT_TIER);
    expect(directUtilityCalls(request)).toEqual([
      { arguments: { paths: ["src"] }, name: "git_diff" },
      { arguments: { paths: ["tests"], staged: true }, name: "git_diff" },
      {
        arguments: { baseRef: base, headRef: head, paths: ["docs"] },
        name: "git_diff",
      },
    ]);
  });

  test("small structured read-only reasoning goes to Nanny", () => {
    expect(
      classifyUtilityExecution(
        inspectRequest({ executionProfile: "search", readScope: ["src"] })
      )
    ).toBe(UTILITY_NANNY_TIER);
    expect(
      classifyUtilityExecution(
        inspectRequest({
          executionPlan: [
            {
              executionProfile: "search",
              objective: "Find the symbol",
              readScope: ["src"],
            },
          ],
          executionProfile: "read-plan",
        })
      )
    ).toBe(UTILITY_NANNY_TIER);
  });

  test("utility audits always keep synthesis with Au Pair", () => {
    const audit = createUtilityRouteRequest({
      acceptanceCriteria: ["return a non-authoritative evidence finding"],
      authority: {},
      executionProfile: "file-read",
      executionRead: { endLine: 20, path: "src/example.ts", startLine: 1 },
      kind: "review",
      objective: "Audit the bounded implementation",
      readScope: ["src/example.ts"],
      requester: "codex",
      reviewMode: "utility-audit",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    expect(classifyUtilityExecution(audit)).toBe(UTILITY_AU_PAIR_TIER);
  });

  test("broader profiled inspection and reasoning-backed commands go to Au Pair", () => {
    expect(
      classifyUtilityExecution(
        inspectRequest({
          executionProfile: "search",
          readScope: ["src/a.ts", "src/b.ts", "src/c.ts"],
        })
      )
    ).toBe(UTILITY_AU_PAIR_TIER);
    expect(
      classifyUtilityExecution(
        createUtilityRouteRequest({
          acceptanceCriteria: ["return reasoned search evidence"],
          authority: {},
          executionProfile: "search",
          kind: "command",
          objective: "Interpret the bounded search results",
          readScope: ["src"],
          requester: "claude",
          requiredCapabilities: ["inspect", "bounded-command"],
          risk: "low",
          writeScope: [],
        })
      )
    ).toBe(UTILITY_AU_PAIR_TIER);
  });

  test("a three-stage reasoning plan goes to Au Pair", () => {
    const plan = ["src/a.ts", "src/b.ts", "src/c.ts"].map((scope) => ({
      executionProfile: "search" as const,
      objective: `Inspect ${scope}`,
      readScope: [scope],
    }));
    expect(
      classifyUtilityExecution(
        inspectRequest({
          executionPlan: plan,
          executionProfile: "read-plan",
          readScope: plan.flatMap((step) => step.readScope),
        })
      )
    ).toBe(UTILITY_AU_PAIR_TIER);
  });

  test("small code-writing proposals and broader plans go to Au Pair", () => {
    const edit = createUtilityRouteRequest({
      acceptanceCriteria: ["return a validated patch"],
      authority: {},
      kind: "edit",
      objective: "Patch the bounded file",
      readScope: ["src/example.ts"],
      requester: "claude",
      requiredCapabilities: ["scoped-edit"],
      risk: "low",
      writeScope: ["src/example.ts"],
    });
    expect(classifyUtilityExecution(edit)).toBe(UTILITY_AU_PAIR_TIER);
    expect(classifyUtilityExecution(inspectRequest())).toBe(UTILITY_NANNY_TIER);

    const plan = Array.from({ length: 5 }, (_, index) => ({
      executionProfile: "search" as const,
      objective: `Find symbol ${index}`,
      readScope: [`src/part-${index}`],
    }));
    expect(
      classifyUtilityExecution(
        inspectRequest({
          executionPlan: plan,
          executionProfile: "read-plan",
          readScope: plan.flatMap((step) => step.readScope),
        })
      )
    ).toBe(UTILITY_AU_PAIR_TIER);
  });

  test("unprofiled bounded inspections go to Nanny", () => {
    expect(classifyUtilityExecution(inspectRequest())).toBe(UTILITY_NANNY_TIER);
    expect(
      classifyUtilityExecution(
        inspectRequest({
          acceptanceCriteria: [
            "compare the two bounded files and return line evidence",
          ],
          objective: "Compare the two declared files for one narrow question",
          readScope: ["src/left.ts", "src/right.ts"],
        })
      )
    ).toBe(UTILITY_NANNY_TIER);
  });

  test("unprofiled Nanny inspections fail closed outside the narrow band", () => {
    const broadScope = inspectRequest({
      readScope: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    const focusedVerification = inspectRequest({
      requiredCapabilities: ["inspect", "focused-verify"],
    });
    const forbiddenAuthority = inspectRequest({
      authority: { dependencyChange: true },
      executionProfile: "search",
    });
    const excessCriteria = inspectRequest({
      acceptanceCriteria: ["a", "b", "c", "d", "e"],
    });
    const oversized = inspectRequest({ objective: "x".repeat(6001) });
    const excessContext = inspectRequest({
      contextRefs: [
        ".loop/context/a.md",
        ".loop/context/b.md",
        ".loop/context/c.md",
      ],
    });
    const unprofiledCommand = createUtilityRouteRequest({
      acceptanceCriteria: ["return bounded command evidence"],
      authority: {},
      kind: "command",
      objective: "Run a bounded command",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["bounded-command"],
      risk: "low",
      writeScope: [],
    });

    for (const request of [
      broadScope,
      focusedVerification,
      forbiddenAuthority,
      excessCriteria,
      oversized,
      excessContext,
      unprofiledCommand,
    ]) {
      expect(classifyUtilityExecution(request)).toBe(UTILITY_AU_PAIR_TIER);
    }
  });
});

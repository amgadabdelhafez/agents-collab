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

  test("edits and broader plans go to Au Pair", () => {
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

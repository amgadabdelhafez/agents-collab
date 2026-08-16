import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callUtilityBridgeTool,
  UTILITY_BRIDGE_TOOLS,
  UtilityBridgeInputError,
} from "../../src/loop/bridge-utility";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  buildUtilityScopeAuditCollection,
  buildUtilityScopeAuditEvidence,
} from "../../src/loop/utility-scope-audit";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const completedScopeAudit = (
  withEvidence: boolean
): { id: string; runDir: string } => {
  const runDir = mkdtempSync(join(tmpdir(), "bridge-utility-scope-"));
  tempDirs.push(runDir);
  const id = withEvidence ? "scope-current" : "scope-legacy";
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return complete Git scope evidence"],
    authority: {},
    executionProfile: "git-status",
    id,
    idempotencyKey: id,
    kind: "review",
    objective: "Audit the declared Git scope",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    reviewMode: "utility-audit",
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  activateUtilityEpoch(runDir, 16);
  appendUtilityRouteRequest(runDir, request);
  transitionUtilityJob(runDir, id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 16,
  });
  claimUtilityJob(runDir, 16, { jobId: id });
  transitionUtilityJob(runDir, id, "running");
  const scopeAudit = buildUtilityScopeAuditCollection([
    buildUtilityScopeAuditEvidence({ mode: "status", paths: ["src"] }, [
      {
        indexStatus: ".",
        kind: "modified",
        path: "src/tracked.ts",
        routing: "helper-visible",
        surfaces: ["worktree"],
        worktreeStatus: "M",
      },
    ]),
  ]);
  transitionUtilityJob(runDir, id, "completed", {
    result: {
      artifactRefs: [],
      checks: [],
      filesChanged: [],
      ...(withEvidence ? { scopeAudit } : {}),
      status: "completed",
      summary: "Scope audit completed.",
    },
  });
  return { id, runDir };
};

test("get_task_result returns only revalidated current scope evidence", async () => {
  const { id, runDir } = completedScopeAudit(true);

  await expect(
    callUtilityBridgeTool("get_task_result", runDir, "codex", { task_id: id })
  ).resolves.toMatchObject({
    result: {
      scopeAudit: {
        manifests: [
          {
            clean: false,
            count: 1,
            records: [expect.objectContaining({ path: "src/tracked.ts" })],
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ],
      },
      status: "completed",
    },
    state: "completed",
  });
});

test("get_task_result rejects historical completed scope audits as legacy unverified", async () => {
  const { id, runDir } = completedScopeAudit(false);

  await expect(
    callUtilityBridgeTool("get_task_result", runDir, "codex", { task_id: id })
  ).rejects.toThrow(
    new UtilityBridgeInputError(
      "scope audit result is legacy/unverified because authoritative Git evidence is absent"
    )
  );
});

test("get_task_result rejects a valid but narrowed persisted manifest", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "bridge-utility-narrowed-"));
  tempDirs.push(runDir);
  const id = "scope-narrowed";
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return complete Git scope evidence"],
    authority: {},
    executionProfile: "git-status",
    id,
    idempotencyKey: id,
    kind: "review",
    objective: "Audit two declared Git paths",
    readScope: ["src", "tests"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    reviewMode: "utility-audit",
    risk: "low",
    workShape: "separable",
    writeScope: [],
  });
  activateUtilityEpoch(runDir, 16);
  appendUtilityRouteRequest(runDir, request);
  transitionUtilityJob(runDir, id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 16,
  });
  claimUtilityJob(runDir, 16, { jobId: id });
  transitionUtilityJob(runDir, id, "running");
  transitionUtilityJob(runDir, id, "completed", {
    result: {
      artifactRefs: [],
      checks: [],
      filesChanged: [],
      scopeAudit: buildUtilityScopeAuditCollection([
        buildUtilityScopeAuditEvidence({ mode: "status", paths: ["src"] }, []),
      ]),
      status: "completed",
      summary: "Scope audit completed.",
    },
  });

  await expect(
    callUtilityBridgeTool("get_task_result", runDir, "codex", { task_id: id })
  ).rejects.toThrow("scope-audit-paths-narrowed");
});

const routeArgs = (executionGitDiff: Record<string, unknown>) => ({
  acceptance_criteria: ["return exact Git evidence"],
  authority: {},
  execution_git_diff: executionGitDiff,
  execution_profile: "git-diff",
  kind: "inspect",
  objective: "Inspect the declared Git diff",
  read_scope: ["src"],
  required_capabilities: ["inspect"],
  risk: "low",
  work_shape: "separable",
  write_scope: [],
});

test("route_task parses explicit worktree, index, range, and read-plan selections", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "bridge-utility-selection-"));
  tempDirs.push(runDir);
  const base = "1".repeat(40);
  const head = "2".repeat(40);

  const worktree = (await callUtilityBridgeTool(
    "route_task",
    runDir,
    "codex",
    routeArgs({})
  )) as { taskId: string };
  const index = (await callUtilityBridgeTool(
    "route_task",
    runDir,
    "codex",
    routeArgs({ staged: true })
  )) as { taskId: string };
  const range = (await callUtilityBridgeTool(
    "route_task",
    runDir,
    "codex",
    routeArgs({ base_ref: base, head_ref: head, operator: "..." })
  )) as { taskId: string };
  const plan = (await callUtilityBridgeTool("route_task", runDir, "codex", {
    ...routeArgs({}),
    execution_git_diff: undefined,
    execution_plan: [
      {
        execution_git_diff: {
          base_ref: base,
          head_ref: head,
          operator: "...",
        },
        execution_profile: "git-diff",
        objective: "Inspect the declared range",
        read_scope: ["src"],
      },
    ],
    execution_profile: "read-plan",
  })) as { taskId: string };

  expect(
    readUtilityJob(runDir, worktree.taskId)?.request.executionGitDiff
  ).toEqual({ kind: "worktree" });
  expect(
    readUtilityJob(runDir, index.taskId)?.request.executionGitDiff
  ).toEqual({ kind: "index" });
  expect(
    readUtilityJob(runDir, range.taskId)?.request.executionGitDiff
  ).toEqual({ base, head, kind: "range", operator: "..." });
  expect(
    readUtilityJob(runDir, plan.taskId)?.request.executionPlan?.[0]
      ?.executionGitDiff
  ).toEqual({ base, head, kind: "range", operator: "..." });

  const routeSchema = UTILITY_BRIDGE_TOOLS.find(
    (tool) => tool.name === "route_task"
  )?.inputSchema;
  expect(JSON.stringify(routeSchema)).toContain("execution_git_diff");
});

test("route_task rejects illegal Git-diff selection states with stable reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "bridge-utility-selection-red-"));
  tempDirs.push(runDir);
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  const invalid = [
    { head_ref: head, operator: "..." },
    { base_ref: base, head_ref: head },
    { base_ref: base, head_ref: head, operator: "...", staged: true },
    { base_ref: "A".repeat(40), head_ref: head, operator: "..." },
    { base_ref: "1234567", head_ref: head, operator: "..." },
    { unsupported: true },
  ];

  for (const selection of invalid) {
    await expect(
      callUtilityBridgeTool("route_task", runDir, "codex", routeArgs(selection))
    ).rejects.toThrow("scope-audit-selection-invalid");
  }
});

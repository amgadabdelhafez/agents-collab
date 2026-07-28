import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBridgeMessage } from "../../src/loop/bridge-store";
import { renderReconPane } from "../../src/loop/recon-pane";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

test("Recon panes project route, exact tool failure, and pending result truth", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-recon-"));
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["return evidence"],
      authority: {},
      id: "recon-job-1234",
      kind: "inspect",
      objective: "Inspect the bounded router state",
      readScope: ["src/loop"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, request);
    activateUtilityEpoch(runDir, 57);
    transitionUtilityJob(runDir, request.id, "routed-utility", {
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-au-pair",
      },
      routeEpoch: 57,
    });
    transitionUtilityJob(runDir, request.id, "failed", {
      result: {
        artifactRefs: [],
        blocker: "scope denied by exact broker boundary",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Au Pair failed closed.",
      },
    });
    const resultRequest = createUtilityRouteRequest({
      acceptanceCriteria: ["return the finding"],
      authority: {},
      id: "result-job-5678",
      kind: "inspect",
      objective: "Read the marker result",
      readScope: ["docs/result.md"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, resultRequest);
    transitionUtilityJob(runDir, resultRequest.id, "routed-utility", {
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "utility-direct",
      },
      routeEpoch: 57,
    });
    claimUtilityJob(runDir, 57, { jobId: resultRequest.id });
    transitionUtilityJob(runDir, resultRequest.id, "running");
    transitionUtilityJob(runDir, resultRequest.id, "completed", {
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: `read_file: ${JSON.stringify({
          content: "## Material shift found\n\nRaw details follow.",
          path: "docs/result.md",
        })}`,
      },
    });
    mkdirSync(join(runDir, "utility"), { recursive: true });
    const repeatedToolEvent = JSON.stringify({
      at: new Date().toISOString(),
      error: {
        code: "scope_denied",
        message: "Directory is outside its exact declared scope",
      },
      jobId: request.id,
      ok: false,
      tool: "list_files",
    });
    appendFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${repeatedToolEvent}\n${repeatedToolEvent}\n`
    );
    appendBridgeMessage(
      runDir,
      "utility",
      "codex",
      `Direct result ${request.id}: read_file: ${JSON.stringify({
        content:
          "# Scope denied by exact broker boundary\n\nRaw details follow.",
      })}`,
      { taskId: request.id }
    );

    const routes = renderReconPane(runDir, 1, { columns: 140, rows: 12 });
    expect(routes).toContain("✗ au pair · Inspect the bounded router state");
    expect(routes).not.toContain(request.id.slice(0, 8));
    expect(routes).not.toContain("utility-au-pair/utility-eligible");
    const tools = renderReconPane(runDir, 2, { columns: 140, rows: 12 });
    expect(tools).toContain("✗ list_files ×2 · scope_denied:");
    expect(tools).toContain("exact declared scope");
    expect(tools).not.toContain(request.id.slice(0, 8));
    const results = renderReconPane(runDir, 3, {
      columns: 140,
      rows: 12,
    });
    expect(results).toContain("1 awaiting delivery");
    expect(results).toContain(
      "→ codex awaiting · Scope denied by exact broker boundary"
    );
    expect(results).toContain("✓ Material shift found");
    expect(
      results.match(/Scope denied by exact broker boundary/g)
    ).toHaveLength(1);
    expect(results).not.toContain("Direct result");
    expect(results).not.toContain('{"content"');
    expect(results).not.toContain(request.id.slice(0, 8));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

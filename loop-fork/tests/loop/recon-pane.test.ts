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
    mkdirSync(join(runDir, "utility"), { recursive: true });
    appendFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        error: {
          code: "scope_denied",
          message: "Directory is outside its exact declared scope",
        },
        jobId: request.id,
        ok: false,
        tool: "list_files",
      })}\n`
    );
    appendBridgeMessage(
      runDir,
      "utility",
      "codex",
      "Au Pair failed closed with exact evidence",
      { taskId: request.id }
    );

    expect(renderReconPane(runDir, 1)).toContain(
      "utility-au-pair/utility-eligible"
    );
    const tools = renderReconPane(runDir, 2, { columns: 140, rows: 12 });
    expect(tools).toContain("scope_denied:");
    expect(tools).toContain("exact declared scope");
    expect(renderReconPane(runDir, 3)).toContain("bridge pending 1");
    expect(renderReconPane(runDir, 3)).toContain("pending→codex");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

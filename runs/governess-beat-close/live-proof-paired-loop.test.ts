// Live proof for the paired-loop finishRun terminal path: the real
// runPairedLoop, with its real default close, closes a synthetic run's
// governess-beat workflow on the real server when the run completes.
//
// Run from loop-fork/:
//   LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233 \
//   LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness \
//   bun test ../runs/governess-beat-close/live-proof-paired-loop.test.ts
//
// Only the agent runner is stubbed (no model is called). HOME is a throwaway
// directory and the run id is `9<epoch ms>`, far above any real run number, so
// `governess-beat:<id>` cannot name a real run's workflow. The workflow is
// started mid-run, while the manifest says `working`, the way a governess
// resumed into this run would have started it.

import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("live: runPairedLoop closes governess-beat:<runId> on completion", async () => {
  const { governessBeatWorkflowId } = await import(
    "../../loop-fork/src/loop/governess-beat-workflow"
  );
  const { prepareGovernessControl } = await import(
    "../../loop-fork/src/loop/governess-journal"
  );
  const { attachGovernessJournalBackend, governessTemporalConfigFromEnv } =
    await import("../../loop-fork/src/loop/governess-temporal-journal");
  const { readRunManifest, resolveRunStorage } = await import(
    "../../loop-fork/src/loop/run-state"
  );
  const config = governessTemporalConfigFromEnv(process.env);
  if (!config) {
    throw new Error("set LOOP_GOVERNESS_TEMPORAL_ADDRESS and _NAMESPACE");
  }
  const UI = process.env.TEMPORAL_UI ?? "http://192.168.1.18:8233";
  const runId = `9${Date.now()}`;
  const home = mkdtempSync(join(tmpdir(), "beatclose-paired-loop-"));
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = runId;
  process.env.LOOP_COOLDOWN_MS = "0";
  const storage = resolveRunStorage(runId, process.cwd(), home);
  const workflowId = governessBeatWorkflowId(runId);
  const log = (label: string, value: unknown) =>
    console.log(`${label} ${JSON.stringify(value)}`);

  // Independent readback: the Temporal UI HTTP API, not the SDK under test.
  const readBack = async () => {
    const response = await fetch(
      `${UI}/api/v1/namespaces/${config.namespace}/workflows/${encodeURIComponent(workflowId)}`
    );
    const info = (
      (await response.json()) as {
        workflowExecutionInfo: {
          closeTime?: string;
          historyLength: string;
          status: string;
        };
      }
    ).workflowExecutionInfo;
    return {
      closeTime: info.closeTime ?? null,
      historyLength: info.historyLength,
      status: info.status,
      workflowId,
    };
  };

  let startedWhileWorking: Awaited<ReturnType<typeof readBack>> | undefined;
  let stateAtStart: string | undefined;
  const runAgent = async (_agent: string, prompt: string) => {
    if (!startedWhileWorking) {
      stateAtStart = readRunManifest(storage.manifestPath)?.state;
      const journalFile = join(storage.runDir, "governess-control.jsonl");
      const backend = await attachGovernessJournalBackend({
        journalFile,
        ownerRepoId: storage.repoId,
        runId,
        temporal: config,
      });
      prepareGovernessControl(journalFile, {
        action: "teardown-loop",
        at: new Date().toISOString(),
        epoch: 1,
        idempotencyKey: `${runId}:proof`,
        payload: `${runId}:proof`,
        policyClass: "require-confirmation",
        policyContext: { confirmed: true, fenceCurrent: true },
      });
      await backend.close();
      startedWhileWorking = await readBack();
    }
    if (prompt.includes("Review this completed work")) {
      return { combined: "", exitCode: 0, parsed: "<review>PASS</review>" };
    }
    if (prompt.includes("Create a draft GitHub pull request")) {
      return { combined: "", exitCode: 0, parsed: "" };
    }
    return { combined: "", exitCode: 0, parsed: "<done/>" };
  };
  mock.module("../../loop-fork/src/loop/runner", () => ({
    runAgent,
    runReviewerAgent: runAgent,
    startPersistentAgentSession: () => Promise.resolve(undefined),
  }));
  const { runPairedLoop } = await import(
    "../../loop-fork/src/loop/paired-loop"
  );

  log("D.run", { home, manifestPath: storage.manifestPath, runId });
  await runPairedLoop("Ship feature", {
    agent: "codex",
    codexModel: "test-model",
    doneSignal: "<done/>",
    format: "raw",
    maxIterations: 1,
    proof: "verify with tests",
    review: undefined,
  } as never);
  log("D.state-when-workflow-started", stateAtStart);
  log("D.started-while-working", startedWhileWorking);
  const finalState = readRunManifest(storage.manifestPath)?.state;
  log("D.manifest", finalState);
  const closed = await readBack();
  log("D.closed", closed);

  expect(stateAtStart).toBe("working");
  expect(startedWhileWorking?.status).toBe("WORKFLOW_EXECUTION_STATUS_RUNNING");
  expect(finalState).toBe("completed");
  expect(closed.status).toBe("WORKFLOW_EXECUTION_STATUS_TERMINATED");
  expect(closed.closeTime).not.toBeNull();
}, 60_000);

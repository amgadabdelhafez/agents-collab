// Live proof for the `loop reconcile stopped-run <id>` terminal path: a
// synthetic stopped run's governess-beat workflow on the real server is closed
// by the real CLI, run as a subprocess.
//
// Run from loop-fork/:
//   bun ../runs/governess-beat-close/live-proof-stopped-run.ts
// with LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233 and
// LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness.
//
// HOME is a throwaway directory, so the run's storage is synthetic. The run id
// is `9<epoch ms>`, far above any real run number, so `governess-beat:<id>`
// cannot name a real run's workflow.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governessBeatWorkflowId } from "../../loop-fork/src/loop/governess-beat-workflow";
import { prepareGovernessControl } from "../../loop-fork/src/loop/governess-journal";
import {
  attachGovernessJournalBackend,
  governessTemporalConfigFromEnv,
} from "../../loop-fork/src/loop/governess-temporal-journal";
import {
  createRunManifest,
  readRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../loop-fork/src/loop/run-state";

const config = governessTemporalConfigFromEnv(process.env);
if (!config) {
  throw new Error("set LOOP_GOVERNESS_TEMPORAL_ADDRESS and _NAMESPACE");
}
const UI = process.env.TEMPORAL_UI ?? "http://192.168.1.18:8233";
const runId = `9${Date.now()}`;
const home = mkdtempSync(join(tmpdir(), "beatclose-stopped-run-"));
const storage = resolveRunStorage(runId, process.cwd(), home);

// Independent readback: the Temporal UI HTTP API, not the SDK under test.
const readBack = async () => {
  const id = encodeURIComponent(governessBeatWorkflowId(runId));
  const response = await fetch(
    `${UI}/api/v1/namespaces/${config.namespace}/workflows/${id}`
  );
  const info = (
    (await response.json()) as {
      workflowExecutionInfo: {
        closeTime?: string;
        historyLength: string;
        memo?: { fields?: Record<string, { data?: string }> };
        status: string;
      };
    }
  ).workflowExecutionInfo;
  const owner = info.memo?.fields?.loopRepoId?.data;
  return {
    closeTime: info.closeTime ?? null,
    historyLength: info.historyLength,
    owner: owner ? Buffer.from(owner, "base64").toString("utf8") : null,
    status: info.status,
    workflowId: governessBeatWorkflowId(runId),
  };
};
const log = (label: string, value: unknown) =>
  console.log(`${label} ${JSON.stringify(value)}`);

const writeManifest = (state: "stopped" | "working") =>
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd: process.cwd(),
      mode: "paired",
      pid: 2_147_483_000,
      repoId: storage.repoId,
      runId,
      state,
      tmuxSession: `beatclose-stopped-run-${runId}`,
      tmuxSocket: join(home, "missing-tmux.sock"),
      workspaceBinding: {
        branchRef: "refs/heads/synthetic",
        repoId: storage.repoId,
        root: process.cwd(),
      },
    })
  );

const cli = (label: string) => {
  const result = Bun.spawnSync(
    ["bun", "src/cli.ts", "reconcile", "stopped-run", runId],
    { env: { ...process.env, HOME: home } }
  );
  log(`${label}.exit`, result.exitCode);
  log(`${label}.stdout`, result.stdout.toString().trim());
  log(`${label}.stderr`, result.stderr.toString().trim());
};

// Start the beat workflow the way a live governess does.
writeManifest("working");
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
log("C.run", { home, manifestPath: storage.manifestPath, runId });
log("C.started", await readBack());

// While the run is live the CLI refuses reconciliation and never closes.
cli("C.cli-while-working");
log("C.after-cli-while-working", await readBack());

// The run stops (as a governess teardown would record) without closing its
// workflow; the operator then reconciles it through the real CLI.
writeManifest("stopped");
cli("C.cli");
log("C.manifest", readRunManifest(storage.manifestPath)?.state);
log("C.closed", await readBack());
cli("C.cli-again");
log("C.still-closed", await readBack());

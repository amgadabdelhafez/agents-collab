// Live proof: a synthetic run's governess-beat workflow on the real server is
// closed by the real terminal code paths, and left open while the run is live.
//
// Run from loop-fork/:
//   bun ../runs/governess-beat-close/live-proof.ts
// with LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233 and
// LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness.
//
// Run ids are synthetic (`beatclose-proof-<epoch>-*`) in a throwaway storage
// root and repo id, so no real run or its workflow is touched.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultGovernessDeps,
  type GovernessConfig,
  stopGovernessLoop,
} from "../../loop-fork/src/loop/governess";
import { reconcileGovernessBeatWorkflows } from "../../loop-fork/src/loop/governess-beat-close";
import { governessBeatWorkflowId } from "../../loop-fork/src/loop/governess-beat-workflow";
import { prepareGovernessControl } from "../../loop-fork/src/loop/governess-journal";
import {
  attachGovernessJournalBackend,
  governessTemporalConfigFromEnv,
} from "../../loop-fork/src/loop/governess-temporal-journal";
import { gcAbandonedRunProcesses } from "../../loop-fork/src/loop/run-process-cleanup";
import {
  createRunManifest,
  readRunManifest,
  writeRunManifest,
} from "../../loop-fork/src/loop/run-state";

const config = governessTemporalConfigFromEnv(process.env);
if (!config) {
  throw new Error("set LOOP_GOVERNESS_TEMPORAL_ADDRESS and _NAMESPACE");
}
const UI = process.env.TEMPORAL_UI ?? "http://192.168.1.18:8233";
const REPO = "beatclose-proof-repo";
const stamp = Date.now();
const storageRoot = mkdtempSync(join(tmpdir(), "beatclose-proof-"));
const DEAD_PID = 2_147_483_000;

// Independent readback: the Temporal UI HTTP API, not the SDK under test.
const readBack = async (runId: string) => {
  const id = encodeURIComponent(governessBeatWorkflowId(runId));
  const response = await fetch(
    `${UI}/api/v1/namespaces/${config.namespace}/workflows/${id}`
  );
  const body = (await response.json()) as {
    workflowExecutionInfo: {
      closeTime?: string;
      historyLength: string;
      memo?: { fields?: Record<string, { data?: string }> };
      status: string;
    };
  };
  const info = body.workflowExecutionInfo;
  const owner = info.memo?.fields?.loopRepoId?.data;
  return {
    closeTime: info.closeTime ?? null,
    historyLength: info.historyLength,
    owner: owner ? Buffer.from(owner, "base64").toString("utf8") : null,
    status: info.status,
    workflowId: governessBeatWorkflowId(runId),
  };
};

const newRun = (runId: string, pid: number) => {
  const runDir = join(storageRoot, REPO, runId);
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      cwd: "/proof",
      mode: "paired",
      pid,
      repoId: REPO,
      runId,
      state: "working",
    })
  );
  return { journalFile: join(runDir, "governess-control.jsonl"), manifestPath, runDir };
};

// Start the beat workflow the way a live governess does: the real backend,
// the real connector, one real record through the sink.
const startBeat = async (runId: string, journalFile: string) => {
  const backend = await attachGovernessJournalBackend({
    journalFile,
    ownerRepoId: REPO,
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
  return backend;
};

const reconcile = () =>
  reconcileGovernessBeatWorkflows({
    env: process.env,
    listTmuxSessions: () => new Set(),
    repoId: REPO,
    storageRoot,
  });

const log = (label: string, value: unknown) =>
  console.log(`${label} ${JSON.stringify(value)}`);

// --- A: abandoned run, closed by startup GC + reconcile ----------------------
const runA = `beatclose-proof-${stamp}-abandoned`;
const a = newRun(runA, DEAD_PID);
const backendA = await startBeat(runA, a.journalFile);
await backendA.close();
log("A.started", await readBack(runA));
log("A.reconcile-while-working", await reconcile());
log("A.after-reconcile-while-working", await readBack(runA));
// The real abandoned-run GC: pid dead, no tmux session -> failed.
gcAbandonedRunProcesses({
  deps: { listTmuxSessions: () => new Set() },
  log: (line) => console.log(`A.gc ${line}`),
  repoId: REPO,
  storageRoot,
});
log("A.manifest-state", readRunManifest(a.manifestPath)?.state);
log("A.reconcile", await reconcile());
log("A.closed", await readBack(runA));
log("A.reconcile-again", await reconcile());
log("A.still-closed", await readBack(runA));

// --- B: governess teardown ---------------------------------------------------
const runB = `beatclose-proof-${stamp}-teardown`;
const b = newRun(runB, process.pid);
const backendB = await startBeat(runB, b.journalFile);
await backendB.sink.flush();
log("B.started", await readBack(runB));
const governessConfig = {
  agents: [],
  epoch: 1,
  journalBackend: backendB,
  journalFile: b.journalFile,
  journalTemporal: config,
  logFile: join(b.runDir, "governess.jsonl"),
  manifestPath: b.manifestPath,
  repoId: REPO,
  runDir: b.runDir,
  runId: runB,
  session: `beatclose-proof-${stamp}-no-such-session`,
  transcriptPath: join(b.runDir, "transcript.jsonl"),
} as unknown as GovernessConfig;
const kills: string[] = [];
const governessLog: unknown[] = [];
await stopGovernessLoop(
  governessConfig,
  {
    ...defaultGovernessDeps(),
    appendLog: (_file, record) => governessLog.push(record),
    // No real run owns processes or a session; everything else is real.
    cleanupRunProcesses: () => ({ killed: [], skipped: [] }),
    fenceCurrent: () => true,
    killSession: (session) => kills.push(session),
  },
  "live proof teardown"
);
log("B.manifest-state", readRunManifest(b.manifestPath)?.state);
log("B.governess-log", governessLog);
log("B.killed-after-close", kills);
log("B.closed", await readBack(runB));

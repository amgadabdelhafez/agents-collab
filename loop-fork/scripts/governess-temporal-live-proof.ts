// gov-6 live proof: write the golden governess fixture through the Temporal
// journal on a real server, kill the "pane" (drop the file journal), recover it
// from history, and compare. Exits nonzero on any mismatch.
//
//   LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233 \
//   LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness \
//   bun run scripts/governess-temporal-live-proof.ts
//
// It runs its own in-process worker on a private task queue so the workflow
// executes this checkout's bundle, and terminates the proof workflow at the end
// so nothing is left running without a worker.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  governessBeatOwnedWorkflowId,
  governessBeatOwner,
} from "../src/loop/governess-beat-identity";
import {
  prepareGovernessControl,
  readGovernessJournal,
  recordGovernessObservation,
  serializeGovernessJournal,
  transitionGovernessControl,
} from "../src/loop/governess-journal";
import type { GovernessControlRecord } from "../src/loop/governess-journal-core";
import {
  attachGovernessJournalBackend,
  connectGovernessTemporalJournal,
  governessTemporalConfigFromEnv,
} from "../src/loop/governess-temporal-journal";
import { temporalWorkflowBundleBase64 } from "../src/loop/temporal-workflow-bundle.generated";
import { TemporalWorkflowPort } from "../src/loop/temporal-workflow-port";
import {
  applyGovernessFixture,
  GOVERNESS_FIXTURE,
} from "../tests/loop/governess-beat-fixture";

const GOLDEN = "tests/fixtures/governess/beat-journal.golden.jsonl";
// The proof journals as a repo of its own, so its workflow id (which names
// the repo, the run and the private task queue) can never be a real run's.
const PROOF_REPO_ID = "gov6-live-proof";

const normalize = (records: readonly GovernessControlRecord[]): string => {
  const ids = new Map<string, string>();
  return records
    .map((record) => {
      if (!ids.has(record.controlId)) {
        ids.set(record.controlId, `control-${ids.size + 1}`);
      }
      return JSON.stringify({
        ...record,
        controlId: ids.get(record.controlId),
      });
    })
    .join("\n");
};

const writeFixture = (journalFile: string): void => {
  applyGovernessFixture(
    {
      prepareGovernessControl: (file, input) =>
        prepareGovernessControl(
          file,
          input as Parameters<typeof prepareGovernessControl>[1]
        ),
      recordGovernessObservation: (file, input) =>
        recordGovernessObservation(
          file,
          input as Parameters<typeof recordGovernessObservation>[1]
        ),
      transitionGovernessControl: (
        file,
        controlId,
        phase,
        at,
        reason,
        details
      ) =>
        transitionGovernessControl(
          file,
          controlId,
          phase as GovernessControlRecord["phase"],
          at,
          reason,
          details as Parameters<typeof transitionGovernessControl>[5]
        ),
    },
    journalFile,
    GOVERNESS_FIXTURE
  );
};

const main = async (): Promise<void> => {
  const base = governessTemporalConfigFromEnv(process.env);
  if (!base) {
    throw new Error("set LOOP_GOVERNESS_TEMPORAL_ADDRESS and _NAMESPACE");
  }
  const config = { ...base, taskQueue: `gov6-live-proof-${process.pid}` };
  const runId = `gov6-live-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  const workflowId = governessBeatOwnedWorkflowId(
    governessBeatOwner({
      repoId: PROOF_REPO_ID,
      runId,
      taskQueue: config.taskQueue,
    })
  );

  const native = await NativeConnection.connect({ address: config.address });
  const worker = await Worker.create({
    connection: native,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowBundle: {
      code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
        "utf8"
      ),
    },
  });
  const workerRun = worker.run();
  const connection = await Connection.connect({ address: config.address });
  const client = new WorkflowClient({
    connection,
    namespace: config.namespace,
  });
  const checks: Record<string, boolean> = {};
  try {
    const journalFile = join(
      mkdtempSync(join(tmpdir(), "gov6-live-")),
      "governess-control.jsonl"
    );
    const first = await attachGovernessJournalBackend({
      journalFile,
      ownerRepoId: PROOF_REPO_ID,
      runId,
      temporal: config,
    });
    writeFixture(journalFile);
    await first.close();
    const written = readGovernessJournal(journalFile);

    // The governess pane dies and its run-dir journal goes with it.
    rmSync(journalFile, { force: true });
    rmSync(`${journalFile}.index.json`, { force: true });

    const second = await attachGovernessJournalBackend({
      journalFile,
      ownerRepoId: PROOF_REPO_ID,
      runId,
      temporal: config,
    });
    await second.close();
    const recovered = readGovernessJournal(journalFile);

    const reader = await connectGovernessTemporalJournal(config, PROOF_REPO_ID);
    const fromHistory = await reader.readRecords(runId);
    await reader.close();
    const port = new TemporalWorkflowPort(client, {
      taskQueue: config.taskQueue,
    });
    const fromWorkflow = (await port.query({ name: "journal", workflowId }))
      .value as unknown as GovernessControlRecord[];
    const golden = readFileSync(GOLDEN, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GovernessControlRecord);

    checks.goldenFromHistory =
      golden.length > 0 && normalize(fromHistory) === normalize(golden);
    checks.historyEqualsFile =
      serializeGovernessJournal(fromHistory) ===
      serializeGovernessJournal(written);
    checks.workflowStateEqualsFile =
      serializeGovernessJournal(fromWorkflow) ===
      serializeGovernessJournal(written);
    checks.recoveredEqualsWritten =
      serializeGovernessJournal(recovered) ===
      serializeGovernessJournal(written);
    checks.recoveryRewroteFromTemporal =
      second.kind === "temporal" &&
      second.recovery.rewroteFile &&
      second.recovery.fileRecords === 0 &&
      second.recovery.temporalRecords === written.length;

    const handle = client.getHandle(workflowId);
    const description = await handle.describe();
    const history = await handle.fetchHistory();
    const signaled = (history.events ?? []).filter(
      (event) => event.workflowExecutionSignaledEventAttributes
    ).length;
    await handle.terminate("gov-6 live proof complete");
    console.log(
      JSON.stringify(
        {
          address: config.address,
          checks,
          eventCount: history.events?.length ?? 0,
          journalRecords: written.length,
          namespace: config.namespace,
          recovery: second.kind === "temporal" ? second.recovery : null,
          runId: description.runId,
          signaledEvents: signaled,
          status: description.status.name,
          workflowId,
          workflowType: description.type,
        },
        null,
        2
      )
    );
  } finally {
    worker.shutdown();
    await workerRun.catch(() => undefined);
    await connection.close();
    await native.close();
  }
  if (!Object.values(checks).every(Boolean) || Object.keys(checks).length < 5) {
    process.exitCode = 1;
  }
};

await main();

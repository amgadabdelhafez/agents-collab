/**
 * Regenerates tests/fixtures/temporal-replay/governess-journal: governess-beat
 * histories written by the pre-fix7 LIVE JOURNAL itself (governess-temporal-
 * journal.ts, signalWithStart of `append_record` under `governess-beat:<runId>`),
 * which tests/loop/governess-beat-legacy-replay.test.ts replays, re-sends and
 * closes on this checkout.
 *
 *   bun run scripts/record-governess-journal-histories.ts
 *
 * The existing replay suite (record-temporal-replay-histories.ts) drives beats
 * through the workflow port; this records what a live governess wrote. For
 * each source commit it extracts that commit's loop-fork/src with git archive
 * and, with that commit's own journal writer, journal client and committed
 * workflow bundle, writes the gov-6 fixture journal through the Temporal
 * journal twice: once with no worker on the queue (production: nothing polls
 * `loop-governess`), once with a worker on the commit's bundle (so the history
 * holds completed workflow tasks for Worker.runReplayHistories). Each history
 * is left RUNNING, as an in-flight run's is.
 *
 * Sources: 4439b2e7 (the installed line's journal: writes the `loopRepoId`
 * owner memo on creation; its journal code is byte-identical to the r6 base)
 * and ec185ba1 (the build first installed with the journal on, cc8d978c,
 * which wrote no memo at all; run 29's `governess-beat:29` came from it).
 *
 * Needs both commits in this clone and the Temporal CLI dev server that
 * TestWorkflowEnvironment.createLocal() starts. Touches no live service.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, defaultPayloadConverter } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  applyGovernessFixture,
  GOVERNESS_FIXTURE,
} from "../tests/loop/governess-beat-fixture";
import {
  bundleDigest,
  extractBuild,
  LOOP_FORK_ROOT,
} from "../tests/support/temporal-replay-builds";

const GOVERNESS_JOURNAL_FIXTURE_DIR = join(
  LOOP_FORK_ROOT,
  "tests/fixtures/temporal-replay/governess-journal"
);
const IDENTITY = "governess-journal-fixture-recorder";
// The repo the 4439b2e7 journal names in its memo, and the production queue.
const LEGACY_FIXTURE_REPO = "legacy-repo-0000000000a1";
const LEGACY_FIXTURE_QUEUE = "loop-governess";
// The worker variants run on their own queue, so no worker ever polls the
// queue the production-shaped (no worker) histories wait on.
const WORKER_QUEUE = "loop-governess-replay-worker";

const SOURCES = [
  {
    label: "installed-4439b2e7",
    ownerMemo: true,
    ref: "4439b2e7ec8d6cfde86c44af3f9818329639c359",
    runIds: { noWorker: "41", worker: "42" },
  },
  {
    label: "first-journal-ec185ba1",
    ownerMemo: false,
    ref: "ec185ba1",
    runIds: { noWorker: "43", worker: "44" },
  },
] as const;

interface OldJournalModule {
  attachGovernessJournalBackend(input: Record<string, unknown>): Promise<{
    close(): Promise<void>;
  }>;
  createGovernessTemporalJournalClient(input: Record<string, unknown>): unknown;
}

const environment = await TestWorkflowEnvironment.createLocal();
const client = new Client({
  connection: environment.connection,
  identity: IDENTITY,
  namespace: environment.namespace,
});
rmSync(GOVERNESS_JOURNAL_FIXTURE_DIR, { force: true, recursive: true });
mkdirSync(GOVERNESS_JOURNAL_FIXTURE_DIR, { recursive: true });
const histories: Record<string, unknown>[] = [];
try {
  for (const source of SOURCES) {
    const build = await extractBuild(
      {
        family: "deployed",
        label: source.label,
        messageIdFormat: "legacy",
        ref: source.ref,
        summary: "governess journal source",
      },
      source.ref
    );
    try {
      const journal = (await import(
        join(build.root, "src/loop/governess-temporal-journal.ts")
      )) as OldJournalModule;
      const writer = await import(
        join(build.root, "src/loop/governess-journal.ts")
      );
      for (const variant of ["noWorker", "worker"] as const) {
        const runId = source.runIds[variant];
        const workflowId = `governess-beat:${runId}`;
        const taskQueue =
          variant === "worker" ? WORKER_QUEUE : LEGACY_FIXTURE_QUEUE;
        const worker =
          variant === "worker"
            ? await Worker.create({
                connection: environment.nativeConnection,
                identity: IDENTITY,
                namespace: environment.namespace,
                taskQueue,
                workflowBundle: { code: build.bundleCode },
              })
            : undefined;
        const running = worker?.run();
        const journalFile = join(
          mkdtempSync(join(tmpdir(), "governess-journal-fixture-")),
          "governess-control.jsonl"
        );
        try {
          const backend = await journal.attachGovernessJournalBackend({
            connect: async () =>
              journal.createGovernessTemporalJournalClient({
                client: client.workflow,
                decode: (payload: unknown) =>
                  defaultPayloadConverter.fromPayload(payload as never),
                ...(source.ownerMemo
                  ? { ownerRepoId: LEGACY_FIXTURE_REPO }
                  : {}),
                taskQueue,
              }),
            journalFile,
            ...(source.ownerMemo ? { ownerRepoId: LEGACY_FIXTURE_REPO } : {}),
            runId,
            temporal: {
              address: "injected",
              namespace: "injected",
              taskQueue,
            },
          });
          applyGovernessFixture(
            writer as never,
            journalFile,
            GOVERNESS_FIXTURE
          );
          await backend.close();
          const records = writer.readGovernessJournal(journalFile) as unknown[];
          const handle = client.workflow.getHandle(workflowId);
          // A worker finishes its last task before the history is taken.
          for (let attempt = 0; variant === "worker"; attempt += 1) {
            const described = await handle.describe();
            if (!described.raw.pendingWorkflowTask) {
              break;
            }
            if (attempt > 500) {
              throw new Error(`${source.label} ${variant}: task never settled`);
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const journalQuery =
            variant === "worker"
              ? await handle.query("workflow-port-query", "journal", undefined)
              : undefined;
          const described = await handle.describe();
          const history = await handle.fetchHistory();
          const file = `${source.label}-${variant}.history.json`;
          writeFileSync(
            join(GOVERNESS_JOURNAL_FIXTURE_DIR, file),
            `${JSON.stringify(JSON.parse(historyToJSON(history)), null, 2)}\n`
          );
          histories.push({
            bundleSha256: bundleDigest(build.bundleCode),
            file,
            ...(journalQuery ? { journalQuery } : {}),
            label: source.label,
            memo: described.memo ?? null,
            records,
            ref: source.ref,
            runId,
            status: described.status.name,
            taskQueue: described.taskQueue,
            variant,
            workflowId,
          });
          console.log(`${source.label} ${variant}: recorded`);
        } finally {
          rmSync(journalFile, { force: true });
          worker?.shutdown();
          await running;
        }
      }
    } finally {
      build.close();
    }
  }
  writeFileSync(
    join(GOVERNESS_JOURNAL_FIXTURE_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        histories,
        ownerRepo: LEGACY_FIXTURE_REPO,
        recordedWith: {
          script: "scripts/record-governess-journal-histories.ts",
          sdk: "@temporalio/worker 1.23.0, TestWorkflowEnvironment.createLocal",
        },
        schema: "governess-journal-fixtures.v1",
      },
      null,
      2
    )}\n`
  );
  const format = spawnSync(
    join(LOOP_FORK_ROOT, "node_modules/.bin/biome"),
    ["format", "--write", GOVERNESS_JOURNAL_FIXTURE_DIR],
    { cwd: LOOP_FORK_ROOT, stdio: "inherit" }
  );
  if (format.status !== 0) {
    throw new Error("biome format of the fixtures failed");
  }
} finally {
  await environment.teardown();
}

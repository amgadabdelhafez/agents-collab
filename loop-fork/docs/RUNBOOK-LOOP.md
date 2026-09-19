# RUNBOOK — loop

> Created by gov-6. This file did not exist before that slice, so it starts with
> the governess beat and grows as later slices add their operational surface.

## Governess beat (gov-6)

The governess beat runs as a Temporal workflow. Its history is the authoritative,
ordered event log, and the JSONL control journal is a read model projected out of
it.

- Workflow type: `governess-beat.v1`
- Workflow id: `governess-beat:<runId>`
- Namespace: `harness`
- Definition: `src/loop/governess-beat-workflow.ts`
- Reducer shared with the JSONL writer: `src/loop/governess-journal-core.ts`

### Turning the Temporal journal on (gov-6 v3)

The live governess writes its journal through the beat workflow only when both
variables are set in the governess pane's environment; with neither set it keeps
the file journal and never loads the Temporal SDK. Setting only one is an error.

```bash
LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233
LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness
LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE=loop-governess   # optional, this is the default
```

- Authority: when both exist, Temporal history is authoritative. The run-dir
  `governess-control.jsonl` stays the synchronous write-ahead copy the governess
  fences against; every record is then signalled (`append_record`, via
  `signalWithStart`) to `governess-beat:<runId>` in order.
- Recovery: on every governess start the file is reconciled from history before
  the epoch is acquired. History wins a disagreement at a held sequence; a file
  that is missing or behind is rewritten from history; a file tail newer than
  history (records the dead pane never signalled) is replayed into history. The
  outcome is logged as `journal-temporal-recovered` in `governess.jsonl`.
- Recovery reads raw history, so it needs the server but not a worker. It waits
  for a settled history (no workflow task in flight, event count stable),
  because Temporal buffers signals that arrive during a workflow task.
- A failed signal is logged as `journal-temporal-append-failed`; later records
  queue behind it and the next start's recovery replays them.
- Live proof: `bun run scripts/governess-temporal-live-proof.ts` with the two
  variables set. It runs its own worker on a private task queue and terminates
  its proof workflow when done.

### One workflow per run, not per seat

The journal's invariants are run-global. The idempotency fence, the monotonic
`sequence` counter, and observation-stream dedupe all key across every seat in a
run. Splitting per seat would shard that fence into independent counters, giving
duplicate sequence numbers with no total order and letting the same idempotency
key pass twice on two different seats. Seat identity travels instead as the
record's `agent` field and inside `observationStream`.

### Inspecting a run

```
loop governess history <run-id>
```

Prints the exported journal read model together with the workflow id and type
that own it. The other governess utility commands are unchanged:

```
loop governess <doctor|replay|explain|history|signals|recover-control-plane> <run-id> [control-id]
```

### Audit contract: metadata only

History carries no prompt bodies.

- Effectful controls cross the boundary as `payloadHash`. The beat workflow
  rejects a `prepare_control` signal that carries a `payload` field, so a body
  cannot reach history even if a caller is careless.
- `payload` is retained only for `observe-runtime`, which is runtime output
  rather than a prompt, and is what lets replay reconstruct decisions.

Callers must hash before signalling. `governess-journal-core.ts` deliberately
imports no Node built-ins — a `node:crypto` import there breaks the webpack
workflow bundle and would drag hashing into the workflow sandbox.

### Changing the beat workflow

The orchestration server registers workflows through the shared bundle, so after
editing `src/loop/temporal-workflow.ts` or any module it pulls in you must
regenerate the bundle or the server keeps running the old code:

```
bun run build:temporal-workflow
```

`LOOP_ORCHESTRATION_WORKFLOW_TYPES` in `src/loop/loop-orchestration-server.ts`
is the declared surface of that bundle.

### Proof suite

`tests/loop/governess-beat-workflow.test.ts` holds the three named checks:

1. deterministic replay — the same fixture reduced twice yields an identical
   decision sequence;
2. journal equality — the exported read model equals the pre-refactor JSONL
   journal, compared by content against a golden generated from the writer at
   commit `80823678` (`tests/fixtures/governess/beat-journal.golden.jsonl`);
3. audit contract — no prompt body appears in any history event or signal
   payload, asserted over the whole event set.

Run it by name:

```
LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/governess-beat-workflow.test.ts
```

## Retired, awaiting the gov-7 cutover

These are unwired but deliberately not deleted; deletion is the cutover's job.

- `src/loop/dbos-replay-runtime.ts`, `src/loop/dbos-replay-worker.ts`,
  `src/loop/dbos-workflow.ts` — replaced by Temporal replay.
- `src/loop/dbos-workflow-port.ts` — not on gov-6's retire list, but now
  reachable only from retired code.
- `replayGovernessJournal` in `src/loop/governess-replay.ts` — replaced by
  Temporal replay. The rest of that file stays wired: it hosts
  `runGovernessUtilityCommand`, which `src/cli.ts` uses for
  `doctor`/`explain`/`signals`/`recover-control-plane`.

`tests/loop/dbos-workflow-port.test.ts` is the retirement guard: it proves the
retired sources are still present, still marked, and still unwired.

## Known risk to carry into gov-7

One beat workflow per run is a single long-running execution, so its Temporal
history grows without bound over a long run. Event-count limits and a
`ContinueAsNew` boundary need a decision in the cutover slice.

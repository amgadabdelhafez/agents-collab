# PLAN — gov-6: the governess journal becomes a read model over Temporal history

Branch `codex/gov-6-journal-to-temporal`, based on `80823678` (exact source of the
installed `loop` binary). Do not rebase onto main.

## Decision on the charter's open question: ONE BEAT WORKFLOW PER RUN

The journal's correctness invariants are run-global, not seat-local:

- `prepareGovernessControl` (`src/loop/governess-journal.ts:346`) closes an
  idempotency fence over `index.latestByIdempotency`, which is keyed across every
  seat in the run.
- `sequence` is a single monotonic counter (`index.sequence + 1`) over one
  `governess-control.jsonl`.
- Observation dedupe keys on `latestObservationByStream`, again run-wide.

One workflow per seat would shard that fence into N independent counters: the
exported journal would carry duplicate sequence numbers with no total order, and a
control prepared for seat A could not dedupe against the same idempotency key
raised on seat B. Seat identity is already a record field (`agent`) and part of
`observationStream`, so per-seat isolation is expressible inside a single history
without splitting the fence.

Workflow id: `governess-beat:<runId>`, namespace `harness`, type `governess-beat.v1`.

Oss reviewed and APPROVED this decision plus both deviations and the reducer
extraction (bridge message f7ff7fde-f946-4c9a-943f-2bd5ddfd22c6).

RISK CARRIED TO gov-7 (raised by Oss, not a blocker for this slice): one
long-running workflow per run grows its Temporal history without bound. Event
count limits and a `ContinueAsNew` boundary need a decision at cutover. Recorded
in `docs/RUNBOOK-LOOP.md`.

## Design

The repo already runs Temporal (`@temporalio/*` 1.23.0) with a generic host
workflow `temporalWorkflow` (`src/loop/temporal-workflow.ts`) that drives pure
`WorkflowDefinition` reducers (`src/loop/workflow-port.ts`) and keeps an ordered
`WorkflowEvent[]` history queryable via `workflow-port-inspection`.

gov-6 adds a `governess-beat.v1` definition to that existing machinery rather than
inventing a second runtime:

1. Extract the pure journal reducer (prepare / observe / transition, phase-order
   rules, idempotency fence, dedupe) out of the fs-coupled
   `governess-journal.ts` into a shared pure core, so the JSONL writer and the
   workflow reducer are provably the same logic and journal equality is a
   property, not a coincidence.
2. New `governess-beat-workflow.ts` implements `WorkflowDefinition` over that core.
   Each tick/signal is a workflow event; decisions are state transitions.
3. `governess-journal.ts` gains the read model: export the journal from workflow
   history/state, producing `GovernessControlRecord[]` byte-identical in content
   to the JSONL the writer produces for the same fixture.
4. Register the definition in `temporal-workflow.ts` and
   `loop-orchestration-server.ts`.
5. CLI: `loop governess history <runId>`.

## Audit contract

Metadata only in history. Effectful control payloads cross the boundary as
`payloadHash` only. `payload` is retained solely for `action === "observe-runtime"`,
which is runtime output, not a prompt body — this preserves the existing invariant
documented at `governess-journal.ts:33-35`.

## Retirement (not deletion)

Mark RETIRED in place, naming the replacement and cutover slice gov-7, and remove
from wiring only:

- `src/loop/governess-replay.ts` — `replayGovernessJournal` is superseded by
  Temporal replay. NOTE: this file also hosts `runGovernessUtilityCommand`, which
  `src/cli.ts:30` uses for `doctor|explain|signals|recover-control-plane`. Those
  are not replay and are not dead, so the file stays wired; only the replay entry
  point is marked RETIRED. Full file retirement is gov-7's cutover.
- `src/loop/dbos-replay-runtime.ts`, `dbos-replay-worker.ts`, `dbos-workflow.ts` —
  reachable only from `tests/loop/dbos-workflow-port.test.ts`. Mark RETIRED, unwire
  the test.
- `src/loop/dbos-workflow-port.ts` is NOT on the charter's list but becomes
  reachable only from retired code. Flag it, do not delete.

## Proof — three named checks, each must fail if behaviour regresses

1. Deterministic replay: same fixture replayed twice from history yields an
   identical decision sequence.
2. Journal equality: the exported read model equals the old JSONL journal for the
   same fixture, compared by content (canonical JSON per record), not line count.
3. No prompt body in any history event: assert over the whole event set, not a
   sample.

Aggregate gates: `bun run check` and `bun run test:ci`, reported as files/pass/fail.
Single-file proof uses `LOOP_TEST_CERTIFICATION_MODE=single-file bun test <file>`.

## Outcome

Implemented and verified. `bun run check` clean over 916 files; `bun run test:ci`
green at 112 files / 1959 pass / 0 fail / 0 skipped.

Each named check was mutation-tested to confirm it fails on regression rather
than passing vacuously:

| mutation | check that failed |
|---|---|
| non-deterministic `at` in prepare | check 1 |
| drop `semanticHash` from observation | check 2 |
| remove the idempotency fence | check 2 |
| remove observation dedupe | check 2 |
| reducer records `payload` for effectful actions | check 3 |

Check 3 initially passed under its mutation because the fixture never handed the
reducer a body to leak; it now probes the reducer directly and fails as intended.

Note on the golden: it was generated from the writer at `80823678` (the
pre-refactor writer, extracted with `git show`), so check 2 compares three
independent producers rather than the new writer against itself.

## Non-goals

Task-graph workflows. usage-tracker changes. Deleting any retired file.

# worker-pool-slot-accounting

Task completed 2026-07-27T01:49:18Z, mode emergent.

## What was built

`startRoutedUtilityJob` now returns whether a worker actually started, and
`processPendingUtilityJob` propagates that as the slot-occupied result, so
terminally failed starts (workspace verification mismatch, spawn returning
false or throwing) no longer consume a pool slot for the rest of the governess
tick. Added `canOnlyAwaitUtilitySlot`, a cheap slots-full precondition that
skips workspace resolution and the jobs.jsonl write-claims parse for pending
jobs that provably can only route to utility (relative, write-free scopes whose
claim-free pure route targets utility); every other job still runs the full
pipeline while the pool is full so non-utility decisions (write-conflict,
protected-scope, peer review, escalation) keep dispatching immediately.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-27T01:38:15Z)
- 002 - slot accounting + slots-full precondition fixed via TDD; full suite at known 4-failure baseline (2026-07-27T01:48:34Z)

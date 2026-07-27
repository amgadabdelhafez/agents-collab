# Task worker-pool-slot-accounting

Created: 2026-07-27T01:38:15Z
Mode: emergent
Description: Fix utility pool slot accounting on failed worker start and skip expensive routing work when slots are full

## What I changed

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

## Why

2026-07-26 worker-pool review confirmed two low-severity issues: failed worker
starts denied a genuinely free slot to later pending jobs until the next tick,
and slot-gated jobs paid 3-5 git subprocesses plus a jobs.jsonl parse per tick
with the decision discarded.

## Notes

TDD: new tests "a job whose worker fails to start does not consume a
worker-pool slot" and "slot-gated utility-only jobs skip workspace resolution
while the pool is full" were watched failing before the fix; guard test
"write-conflicted jobs still dispatch to the driver while the pool is full"
pins the preserved slots-full dispatch behavior. Full suite: 809 pass / 4 fail,
exactly the known Codex-launch baseline failures. Lint/format/tsc diffs
against HEAD baselines show zero new findings (13 biome findings and the
line-1032 tsc error are pre-existing formatter/type drift in untouched code).

Regression: yes
Regression id: utility-pool-slot-leak-on-failed-start
Regression symptom: A worker that failed to start still occupied a pool slot, leaving later pending jobs undispatched until the next governess tick.
Regression guard: tests/loop/utility-runtime.test.ts ("a job whose worker fails to start does not consume a worker-pool slot")

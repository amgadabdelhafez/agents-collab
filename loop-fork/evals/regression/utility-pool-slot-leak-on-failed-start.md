# Regression Eval: utility-pool-slot-leak-on-failed-start

Generated: 2026-07-27T01:49:18Z
Source task: `worker-pool-slot-accounting`
Status: draft

## Failure Symptom

- A worker that failed to start still occupied a pool slot, leaving later pending jobs undispatched until the next governess tick.

## Guard Evidence

- tests/loop/utility-runtime.test.ts ("a job whose worker fails to start does not consume a worker-pool slot")

## Verification Artifacts

- `unit`: `runs/worker-pool-slot-accounting/artifacts/unit/verify.log` (pass)

## Source Task Notes

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

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

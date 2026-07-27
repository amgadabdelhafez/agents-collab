# Regression Eval: utility-worker-denial-runaway

Generated: 2026-07-27T16:16:55Z
Source task: `utility-worker-runaway-guard`
Status: draft

## Failure Symptom

- A broker-denied tool call was retried hundreds of times.

## Guard Evidence

- tests/loop/utility-runtime.test.ts

## Verification Artifacts

- `unit`: `runs/utility-worker-runaway-guard/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: utility-worker-denial-runaway
Regression symptom: A broker-denied tool call was retried hundreds of times.
Regression guard: tests/loop/utility-runtime.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

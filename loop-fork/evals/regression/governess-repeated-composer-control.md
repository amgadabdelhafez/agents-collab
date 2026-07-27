# Regression Eval: governess-repeated-composer-control

Generated: 2026-07-25T22:19:09Z
Source task: `governess-native-runtime`
Status: draft

## Failure Symptom

- A repeated governess rename/control can remain in the shared composer and consume later Claude or user input.

## Guard Evidence

- tests/loop/governess-runtime.test.ts, tests/loop/governess-exit.test.ts, tests/loop/governess-hooks.test.ts, and tests/loop/governess.test.ts

## Verification Artifacts

- `unit`: `runs/governess-native-runtime/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governess-repeated-composer-control
Regression symptom: A repeated governess rename/control can remain in the shared composer and consume later Claude or user input.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

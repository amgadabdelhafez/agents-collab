# Regression Eval: stamped-review-exit-zero-malformed-output

Generated: 2026-08-04T18:32:47Z
Source task: `review-sender-output-guards`
Status: draft

## Failure Symptom

- Removing a sender output guard did not fail its test suite.

## Guard Evidence

- tests/loop/review-request-gate.test.ts

## Verification Artifacts

- `build`: `runs/review-sender-output-guards/artifacts/build/verify.log` (pass)
- `check`: `runs/review-sender-output-guards/artifacts/check/verify.log` (pass)
- `focused`: `runs/review-sender-output-guards/artifacts/focused/verify.log` (pass)
- `full`: `runs/review-sender-output-guards/artifacts/full/verify.log` (pass)
- `unit`: `runs/review-sender-output-guards/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: stamped-review-exit-zero-malformed-output
Regression symptom: Removing a sender output guard did not fail its test suite.
Regression guard: tests/loop/review-request-gate.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

# Task review-sender-output-guards

Created: 2026-08-04T18:28:36Z
Mode: planned
Description: Close Claude's survived mutation by proving the stamped review sender refuses exit-zero malformed gate output

## What I changed

- Added producer-backed tests that execute an unchanged copied governed sender
  beside a fake exit-zero gate.
- Proved each required output conjunct independently: missing
  `REVIEW_GATE_STAMP_V1` and missing `status=PASS` both refuse before xchan.

## Why

Claude's exact-SHA review of `4a4d94f` killed the router and validator
mutations but the sender output-guard mutation survived because existing tests
only exercised a nonzero gate exit.

## Notes

Regression: yes
Regression id: stamped-review-exit-zero-malformed-output
Regression symptom: Removing a sender output guard did not fail its test suite.
Regression guard: tests/loop/review-request-gate.test.ts

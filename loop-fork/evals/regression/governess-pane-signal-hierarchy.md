# Regression Eval: governess-pane-signal-hierarchy

Generated: 2026-07-28T03:08:15Z
Source task: `governess-pane-cleanup`
Status: active

## Failure Symptom

- The Governess pane was visually dense, repetitive, and hard to scan despite
  having spare vertical space.

## Guard Evidence

- tests/loop/governess.test.ts

## Verification Artifacts

- `build`: `runs/governess-pane-cleanup/artifacts/build/verify.log` (pass)
- `unit`: `runs/governess-pane-cleanup/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governess-pane-signal-hierarchy
Regression symptom: The Governess pane was visually dense, repetitive, and
hard to scan despite having spare vertical space.
Regression guard: tests/loop/governess.test.ts

## Execution

`tests/loop/governess.test.ts` asserts the primary/helper table separation,
bridge grouping, human-readable routing and worker metrics, concise Nanny
model/runtime lines, viewport bounds, and small-pane preservation.

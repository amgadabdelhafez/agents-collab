# Regression Eval: launch-smoke-reservation-binding

Generated: 2026-08-04T18:54:37Z
Source task: `launch-smoke-reservation-binding`
Status: draft

## Failure Symptom

- The realistic release smoke failed after a healthy reserved numeric run because it predicted a retired named manifest path and eight-pane layout.

## Guard Evidence

- tests/loop/launch-smoke-manifest.test.ts plus evals/smoke/large-prompt-launch.sh

## Verification Artifacts

- `build`: `runs/launch-smoke-reservation-binding/artifacts/build/verify.log` (pass)
- `check`: `runs/launch-smoke-reservation-binding/artifacts/check/verify.log` (pass)
- `focused`: `runs/launch-smoke-reservation-binding/artifacts/focused/verify.log` (pass)
- `full`: `runs/launch-smoke-reservation-binding/artifacts/full/verify.log` (pass)
- `unit`: `runs/launch-smoke-reservation-binding/artifacts/unit/verify.log` (pass)

## Source Task Notes

- The reviewed candidate binary remained byte-identical at
  `d24bc967a2ae4cb810529cf300be3048a799fdb6fdd46231cb24460d0f0d987e`.
- The corrected exact-prebuilt 10 KiB smoke passed all launch, layout,
  readiness, timeout preservation, hash mismatch, missing workspace, and host
  isolation checks.
- `bun run check`, `bun run build`, and the full sequential `bun run test:ci`
  suite passed.

Regression: yes
Regression id: launch-smoke-reservation-binding
Regression symptom: The realistic release smoke failed after a healthy reserved numeric run because it predicted a retired named manifest path and eight-pane layout.
Regression guard: tests/loop/launch-smoke-manifest.test.ts plus evals/smoke/large-prompt-launch.sh

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

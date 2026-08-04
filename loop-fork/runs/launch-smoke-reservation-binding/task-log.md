# Task launch-smoke-reservation-binding

Created: 2026-08-04T18:47:20Z
Mode: planned
Description: Update the realistic launch smoke to derive the numerically reserved run manifest and fail closed on zero or multiple manifests

## What I changed

- Replaced predicted named-run manifest paths with fail-closed discovery of
  exactly one producer manifest under each isolated case's repo ID.
- Bound every existing manifest and host-isolation assertion to the persisted
  producer `runId`.
- Updated the detached-layout gate from the retired eight-pane topology to the
  reviewed six-pane layout with one consolidated activity pane.
- Added a focused regression that rejects zero and multiple manifest candidates.

## Why

Atomic paired-launch reservation now allocates numeric run IDs before the child
launcher starts. The release smoke still treated `LOOP_RUN_ID` as authoritative,
so a healthy `repo-loop-1` launch failed the gate at a nonexistent named path.
The next assertion was also stale after the three recon panes were consolidated.

## Notes

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

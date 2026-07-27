# worker-unbounded-steps task log

- Motivation: four consecutive live loop-48 utility jobs failed with "worker
  reached its step limit without completion" (16-model-call budget undersized
  for routed inspection tasks); each failure escalated to a driver pane.
- TDD: `maxSteps` absence assertion observed failing before the change.
- Removed `DEFAULT_MAX_STEPS`, the `maxSteps` config field, and
  `LOOP_UTILITY_MAX_STEPS` resolution. The conversation loop is now bounded by
  the existing `maxJobRuntimeMs` (default 15 min) — the same budget governess
  stale recovery uses — so a worker stops spending when its job would be
  recovered anyway; exhaustion throws "worker exceeded its runtime limit
  without completion".
- Verification: utility-runtime + utility-store 36/36; full suite 806 passed
  with the same four baseline Codex-launch failures; build and
  `git diff --check` clean; no new lint findings on touched files.
- Deployment: merge + rebuild of `loop-fork/loop` only; workers spawn per job
  from the binary, so no pane, governess, or bridge-worker restarts needed.

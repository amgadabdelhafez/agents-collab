# Worker unbounded steps

## Problem

Since 00:41Z on loop 48, four consecutive utility jobs failed with "worker
reached its step limit without completion": the 16-model-call step budget is
undersized for the git-show/doc-inspection tasks being routed, and every
failure escalates to a driver pane. Token limits were already removed
(`worker-unbounded-cost`); the step budget is the remaining artificial cap.

## Requirements

- Remove `maxSteps` and `LOOP_UTILITY_MAX_STEPS`; the conversation loop runs
  until the model completes (no tool calls) or errors.
- The existing `maxJobRuntimeMs` budget (default 15 min) becomes the in-worker
  bound: the loop throws once elapsed time exceeds it, so a worker cannot keep
  spending after governess stale recovery has already failed the job.
- No other worker behavior changes (evidence assertions, artifacts, usage
  accounting, trace events unchanged).

## Acceptance

- Resolved config no longer exposes `maxSteps`.
- Existing utility-runtime and utility-store suites stay green; full suite at
  the 4-failure baseline; build passes.
- Live: rebuild only — no pane, governess, or bridge-worker restarts; the next
  routed inspection job is free of step-limit failures.

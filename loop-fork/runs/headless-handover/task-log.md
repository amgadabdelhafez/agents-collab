# Task headless-handover

Created: 2026-07-29T18:41:42Z
Mode: planned
Description: Complete graceful handover when an agent TUI pane is affirmatively missing while preserving unknown-liveness fail-closed behavior and existing run-owned teardown.

## What I changed

- Preserved a completed tmux probe's missing-target result as `1:missing`
  instead of collapsing it into unknown evidence. Timed-out or thrown control
  probes still return unknown and remain non-destructive.
- A validated headless bundle now skips terminal `/exit`, while a live peer
  keeps the existing guarded exit path.
- The transaction regression proves no teardown before replacement acceptance,
  then reuses the existing mark, run-owned cleanup, and tmux-kill order.

## Why

Harvto runs 98 and 99 required manual teardown because a missing agent pane was
reported as unknown and blocked the graceful handover transaction upstream of
the existing lifecycle owner.

## Notes

- Harness focused verification passed 60 tests with zero failures.
- The complete sequential repository suite passed; final verifier success is
  being re-run after recording the required eval verdict.

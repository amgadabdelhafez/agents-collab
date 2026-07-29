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

Regression: yes
Regression id: headless-handover-missing-pane
Regression symptom: A confirmed-missing driver pane blocked graceful handover forever because it was collapsed into unknown liveness.
Regression guard: tests/loop/governess-exit.test.ts

- Harness focused verification passed 60 tests with zero failures.
- The complete sequential repository suite passed; final verifier success is
  being re-run after recording the required eval verdict.
- Claude independently reran the 1,217-test suite, reproduced binary SHA-256
  `7cd14f7bf5e75381818d3fa329195677022160efd00cdfee2c1138958629d893`,
  and issued CONCUR `872441f9-7f8e-4088-954c-81aa406616a7` bound to exact SHA
  `c02c43fa7f021bc6163032b5b0c019e368b61d5c`.
- The reviewed binary was installed for future processes. Live run 100 was not
  restarted, signaled, or hot-swapped.

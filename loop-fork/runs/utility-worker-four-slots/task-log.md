# Task utility-worker-four-slots

Created: 2026-07-27T15:42:26Z
Mode: planned
Description: Raise the default utility worker pool from two to four slots while preserving the 1-8 override and live safety

## What I changed

- Applied `LOOP_UTILITY_MAX_CONCURRENCY=4` to live loop 53 and respawned only
  its governess pane.
- Preserved Claude PID 14054, Codex PID 14056, and the visible worker pane PID
  14468.
- Updated the utility pool specification before source implementation.
- Changed the source default and CLI help from two slots to four.
- Updated the pool regression to start four jobs, queue a fifth, and start the
  fifth after one job becomes terminal.

## Why

Two pathological utility jobs occupied the previous two-slot pool while seven
new requests remained pending. Four slots restore bounded throughput without
raising the existing maximum or broadening authority.

## Notes

Regression: no

The retry-loop behavior that caused the original slot starvation is a separate
follow-up. This slice changes capacity only.

## Verification

- Focused utility runtime/store suite: 36 passed, 0 failed.
- Full suite: 890 passed, 4 unchanged Codex launch/config expectation failures.
- Build: passed.
- `git diff --check`: passed.
- `bun run check`: unavailable because `ultracite` is not installed in the
  isolated worktree; the required diff check passed instead.
- Live loop 53: four simultaneous workers observed, completed count increased
  from 2 to 14, and Claude/Codex pane PIDs remained unchanged.
- Installed candidate SHA-256
  `91f1a7a09484e6dee0c5d443dccf21b45b702686be88d80ac4198542f9b95a9a`
  into the canonical binary; the global launcher resolves to the same hash and
  reports a default of four.
- Independent re-evaluation: PASS with no actionable findings.

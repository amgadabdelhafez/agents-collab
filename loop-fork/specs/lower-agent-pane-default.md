# lower-agent-pane-default

Task completed 2026-07-26T03:36:17Z, mode planned.

## What was built

- Added a default top-right utility observer to paired tmux startup, sized to
  eight visible rows after the governess split.
- Persisted left, right, utility, and governess pane targets in the run
  manifest; bridge delivery and governess observation consume those targets.
- Expanded the read-only pane with readiness, queue counts, current objective,
  latest bounded tool, and latest token/cost status.
- Documented `LOOP_UTILITY_PANE=0` as the explicit three-pane opt-out and added
  `LOOP_UTILITY_PANE_HEIGHT`.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-26T03:23:05Z)
- 002 - Top-right utility layout specified; persist pane targets to remove fixed-index coupling (2026-07-26T03:23:05Z)
- 003 - Default top-right utility observer verified in real tmux; persisted pane targets keep bridge and governess routing stable (2026-07-26T03:35:58Z)

# readiness-timeout-preservation

Task completed 2026-07-31T08:32:53Z, mode planned.

## What was built

- Traced the evidence loss to an untyped readiness-timeout error falling into
  generic failed-start teardown.
- Added a spec-first acceptance contract under
  `../specs/readiness-timeout-preservation/`.
- Added a narrow startup input-required error base shared by composer recovery
  and readiness poll exhaustion. Unexpected capture and tmux failures remain on
  the terminal failed-start path.
- Made the realistic-prompt smoke inspect `input-required/running`, both stable
  agent pane targets, absent control panes, absent work delivery, and the exact
  attach command before explicitly cleaning its isolated session.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-31T08:06:25Z)
- 002 - spec and acceptance gate (2026-07-31T08:10:00Z)
- 003 - implementation and focused smoke green (2026-07-31T08:18:48Z)

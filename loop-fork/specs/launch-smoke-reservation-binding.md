# launch-smoke-reservation-binding

Task completed 2026-08-04T18:54:37Z, mode planned.

## What was built

- Replaced predicted named-run manifest paths with fail-closed discovery of
  exactly one producer manifest under each isolated case's repo ID.
- Bound every existing manifest and host-isolation assertion to the persisted
  producer `runId`.
- Updated the detached-layout gate from the retired eight-pane topology to the
  reviewed six-pane layout with one consolidated activity pane.
- Added a focused regression that rejects zero and multiple manifest candidates.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-04T18:47:20Z)
- 002 - release smoke follows numeric reservation and consolidated layout; all required dimensions pass (2026-08-04T18:54:14Z)

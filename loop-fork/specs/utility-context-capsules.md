# utility-context-capsules

Task completed 2026-07-27T18:34:08Z, mode planned.

## What was built

- Added a protected, provider-neutral `UTILITY.instructions.md` project brief.
- Built deterministic, bounded per-job context capsules from the root brief and
  explicitly selected repository references, with stable hashes and persisted
  replay artifacts.
- Passed capsule metadata through routing, bridge, runtime, usage evidence, and
  governess observability without expanding worker authority.
- Added one-shot `CONTEXT_INSUFFICIENT` escalation and runtime-owned pane
  summaries so provider output cannot echo hidden context into the worker pane.
- Added loader, path-boundary, routing, runtime, escalation, observability, and
  pane-leak regression tests.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-27T18:06:45Z)
- 002 - spec approved: bounded provider-neutral context capsule, utility remains stateless and governess-owned (2026-07-27T18:08:43Z)
- 003 - implementation-tested (2026-07-27T18:23:39Z)
- 004 - utility-context-capsules reviewed implementation ready for installation (2026-07-27T18:32:29Z)
- 005 - installed and all gates passed (2026-07-27T18:33:47Z)

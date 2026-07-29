# cross-repo-stale-bridge-sweep

Task completed 2026-07-29T19:48:42Z, mode planned.

## What was built

- Added the root spec, plan, tasks, and verification contract.
- Inspected the current-repository abandoned-run GC, CLI startup ordering, and
  live macOS process shapes.
- Added `stale-bridge-cleanup.ts` as an isolated startup maintenance path. It
  enumerates only exact `loop` executables, accepts only the direct
  `__bridge-mcp` argv shape, requires a canonical two-level run directory, and
  signals only for a strict terminal manifest or an affirmatively absent run.
- Rechecks run state and then rereads the exact PID executable and command
  immediately before `SIGTERM`; changed, unreadable, or active evidence spares.
- Wired the sweep after the immediate helper/version/help bypass and before the
  current-repository abandoned-run GC.
- Added adversarial and CLI ordering tests.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-29T18:55:09Z)
- 002 - Specified fail-closed cross-repo bridge sweep before implementation (2026-07-29T18:55:10Z)
- 003 - exact-SHA concur deploy and supervised live spare-path validation complete (2026-07-29T19:48:41Z)

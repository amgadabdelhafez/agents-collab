# governess-native-runtime

Task completed 2026-07-25T22:19:09Z, mode planned.

## What was built

- Created a spec-first implementation slice for structured runtime events,
  acknowledged controls, semantic handover, replay/explain, and compact layout.
- Recorded the OSS pattern review and chose adaptation over new dependencies.
- Added agent-hook lifecycle IDs/sequences/states and made hook evidence
  authoritative over terminal-derived fallback state.
- Routed Claude through its channel and Codex through its app-server/bridge;
  terminal input is now a guarded fallback with a last-moment draft check.
- Added monotonic control phases, post-dispatch hook reconciliation, safe-only
  retries, policy inputs, transport/evidence receipts, behavioral replay, and
  `governess explain`.
- Split each runtime tick into an immutable observation snapshot, pure decision
  function, and fenced executor.
- Added digest-bound handover manifests and replacement-loop acceptance before
  old-loop teardown.
- Added dynamic judge-row budgeting for small panes.
- Bounded behavioral cycle snapshots to only the hook evidence that caused a
  transition; a live run exposed and verified the fix for unbounded records.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-25T21:49:56Z)
- 002 - spec and OSS reuse decision complete (2026-07-25T21:52:49Z)
- 003 - native lifecycle receipts and semantic handover verified (2026-07-25T22:11:50Z)
- 004 - verified live bounded lifecycle and reconciliation (2026-07-25T22:19:03Z)

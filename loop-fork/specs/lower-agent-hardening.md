# lower-agent-hardening

Task completed 2026-07-26T16:46:24Z, mode planned.

## What was built

- Added strict repository command-policy loading and local/offline
  `npx vitest run <scoped-file>` support.
- Added PID-bearing worker claims and governess-owned dead/runtime reaping.
- Added full-agent-only guarded patch application with patch+manifest hashes,
  immediate preimage verification, canonical write-scope checks, and durable
  postimages.
- Replaced inherited worker environments with an allowlist and key-file-only
  production launch path.
- Persisted safe availability detail in route decisions and rendered it in the
  observer pane.
- Added pessimistic estimate-less reservations and a $0.25 default run cap.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-26T16:12:05Z)

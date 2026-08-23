# webui-all-active-loops

Task completed 2026-08-22T00:08:51Z, mode planned.

## What was built

- Replaced the single-run adapter with bounded, symlink-safe discovery across
  direct repository directories and direct numeric run directories in the
  shared loop registry.
- Projected each valid active run independently, with manifest-only degraded
  rows for unreadable optional evidence and fleet-level partial quality for
  omitted invalid manifests.
- Added collision-safe `repositoryId:runId` routes, derived repository labels,
  repository filters, generic fleet copy, correct working counts, and an
  explicit no-longer-active detail state.
- Made lifecycle arbitration timestamp-aware across Governess and hook
  evidence. Losing evidence is marked stale and stale tool-start hooks cannot
  claim a tool remains in flight.
- Tightened the client DTO boundary so synthetic/fixture provenance,
  contradictory fleet/detail summaries, and malformed worker completion
  metrics fail closed.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-21T22:43:48Z)
- 002 - all-active-loop discovery contract (2026-08-21T22:46:50Z)

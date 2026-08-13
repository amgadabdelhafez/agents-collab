# Task harvto-d3-pending-route

Created: 2026-08-13T17:40:21Z
Mode: emergent
Description: D3 P1: make route_task durably reject or terminate when no eligible utility worker/router exists; no pending-route forever state.

## What I changed

- Added one deterministic Governess fail-closed owner for durable `pending-route` jobs when current
  workspace, driver, or peer routing evidence is incomplete.
- Added explicit `routing-owner-unavailable` decision evidence and replay-safe state transition.
- Added D3 Governess and utility-runtime regression coverage; preserved no-tier, stale-epoch,
  capacity-recovery, D1, and D4 controls.

## Why

Accepted work previously remained `pending-route` forever because Governess skipped utility
reconciliation when no routing peer existed. Durable escalation makes that absence attributable
without treating temporary worker capacity pressure as permanent failure.

## Notes

No UI, dependency, provider/model, Harvto, remote, release, or `.loop/` change. Canonical focused,
static, build, and 77-file serial tests pass. Exact commit
`9d1ce5dbfe1831fafdabcad7260e6c22dd5d5ecd` received Claude zero-write static `PASS` via bridge
`0e404eeb-1bca-45eb-a829-9299c46fb342`; Claude did not rerun the checks. Harness closure remains.

Claude disclosed unauthorized paid Au Pair audit task `9301b78a-7e6f-42a8-bcbe-7576f0ac6d53`
during review. Its scope-incomplete five-path result is discarded; run-local usage records cost
`$0.006511969`. No implementation or evidence file was written by that audit, and no further paid
utility use is allowed.

Harness closure completed exactly once at `2026-08-13T18:49:48Z`. Post-task invariants passed,
debt scan found zero issues, completion metadata is durable, and no task remains active.

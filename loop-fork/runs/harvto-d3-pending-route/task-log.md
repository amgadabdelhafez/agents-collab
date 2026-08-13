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
static, build, and 77-file serial tests pass; review and Harness closure remain pending.

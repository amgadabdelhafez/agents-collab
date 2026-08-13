---
seq: 002
date: 2026-08-13T17:40:21Z
trigger: promote
topic: promoted parked idea
---

## Decided

- Promoted parked idea `specs/harvto-d3-pending-route.md` into active task `harvto-d3-pending-route`.
- Assigned the missing routing-owner branch to Governess and utility-runtime with one durable
  `routing-owner-unavailable` escalation.
- Preserved temporary full-tier backlog, stale-epoch fencing, replay idempotency, and complete
  routing behavior.
- Committed the exact 32-path D3 range at
  `9d1ce5dbfe1831fafdabcad7260e6c22dd5d5ecd`; Claude returned zero-write static `PASS` via bridge
  `0e404eeb-1bca-45eb-a829-9299c46fb342`.

## Still open

- None within D3 after Harness lifecycle closure. D5 and later defects remain separate tasks.

## Where we are

- Implementation, focused checks, full verification, exact-scope commit, and peer review pass are
  complete. Exactly-once Harness closure and its bookkeeping commit are next.

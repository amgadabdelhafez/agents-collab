# Task harvto-d8-stale-write-lease

Created: 2026-08-17T16:27:46Z
Mode: emergent
Description: D8 P2: reject stale utility write leases before mutation after authority changes; reproduce the dead lease routing a two-file write.

## What I changed

- Added an awaited, refreshed utility patch-authority lock that validates current, route, and
  persisted claim epochs before broker construction and holds authority through mutation and
  application journaling.
- Routed guarded Au Pair patch application through that critical section while preserving broker
  manifest, scope, preimage, applicability, workspace, and replay protections.
- Added deterministic stale-authority, lock-retention, activation-contention, busy-identity, valid
  apply, and one-event replay regressions in the two reviewed test files.
- Preserved and independently validated one exact-base two-file red, then passed all focused and
  mandatory checks, dual evals, Harness gates, root verification, and exact-SHA zero-write review.

## Why

A completed utility edit retained enough artifact metadata to apply after its Governess utility
epoch had been superseded. The fix prevents stale actor authority from reaching real file mutation
without weakening the separate D10 object-byte guards.

## Notes

- Implementation commit: `ece4c6eb92a9bc61034d181868c5cd9287bffb6e`.
- Claude exact-SHA `PASS`: `1d2f0750-54de-41ba-8c03-bf69c2c4aa00`.
- The implementation commit contains only the exact two production and two test paths; lifecycle,
  eval, evidence, and ledger changes remain separate bookkeeping.

# harvto-d1-live-peer-expiry Plan

Mode: emergent

## Objective

Fix D1 only: TTL and queue depth cannot terminalize an accepted durable message unless current
peer-scoped authoritative evidence confirms the intended target dead. Preserve idempotency and bound
the pending set.

## Tasks

- [x] Promote, trace, and reproduce both terminal paths before production changes.
- [x] Record exact invariant, liveness authority, journal compatibility, and retained ceiling.
- [x] Apply narrow bridge-store/dispatch fix and focused controls.
- [ ] Pass focused/full checks, repo-root verify, Harness preflight/stop-gate, and exact-SHA review.

## Proof locations

- Baseline: `runs/harvto-d1-live-peer-expiry/artifacts/baseline-reproduction.md`
- Feature contract: `specs/harvto-d1-live-peer-expiry/`
- Final eval: repository-root `runs/harvto-d1-live-peer-expiry/eval.json`

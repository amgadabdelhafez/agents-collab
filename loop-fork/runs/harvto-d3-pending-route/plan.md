# harvto-d3-pending-route Plan

Mode: emergent
Description: D3 P1: make route_task durably reject or terminate when no eligible utility worker/router exists; no pending-route forever state.

## Objective

Reproduce and fix durable utility work remaining `pending-route` when no current router can decide
it, while preserving intentional backlog for a temporarily full eligible pool.

## Scope

- `route_task` admission and durable utility request creation.
- Governess ownership of pending-route processing when holder/peer/router evidence is missing.
- Existing route policy, utility journal transitions, replay, and capacity backlog.
- Focused D3 regression and D1/D4 controls.
- D3-only Harness evidence, matrix section, both eval schemas, `PLAN.md`, and `status.md`.


## Proposed Tasks

### 1. Reproduce and settle owner

- [x] Trace admission, route store, Governess drain, and deterministic route decision.
- [x] Add a named regression against unchanged base
  `d5d3140844f9ff7f8447156f4b4f7f27ac093d96`.
- [x] Record one durable request, absent decision, and decisive pending-state failure.

### 2. Fix only the reproduced branch

- [x] Add one fail-closed decision owner for missing holder/peer/router evidence.
- [x] Preserve no-tier routing, stale epoch fencing, idempotency, and capacity recovery.

### 3. Test and verify

- [ ] Run Governess, utility-runtime/store, bridge, and D1/D4 focused controls.
- [ ] Run check, canonical typecheck, build, full serial suite, Harness gates, and root verifier.
- [ ] Commit explicit D3 paths and obtain Claude zero-write exact-SHA `PASS`.
- [ ] Close Harness once after review and continue to D5.

## Non-goals

- Harvto or preserved-run mutation.
- D5-D16 implementation.
- Dependency, provider, model, utility-spend, UI, remote, release, merge, rebase, push, or deploy.
- `.loop/` editing, staging, or deletion.

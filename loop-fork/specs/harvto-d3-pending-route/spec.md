# D3 Pending Route Admission and Recovery

## Goal

Ensure `route_task` never reports durable work as healthy `pending-route` when no current routing
owner can decide it. A request must either have an eligible, recoverable routing path or receive one
durable attributable non-utility/terminal decision.

## Exact base

`d5d3140844f9ff7f8447156f4b4f7f27ac093d96`

## Scope

- `src/loop/bridge-utility.ts` admission and returned route state.
- `src/loop/utility-store.ts` request, queued decision, and terminal transition durability.
- `src/loop/task-router.ts` existing `utility-unavailable` and capability routing policy.
- `src/loop/governess.ts` ownership of pending-route drain invocation.
- `src/loop/utility-runtime.ts` bounded routing, capacity backlog, restart, and replay behavior.
- Existing bridge, Governess, utility-runtime, and utility-store test boundaries.
- D3-only Harness evidence, defect-matrix section, evals, `PLAN.md`, and `status.md`.

No Harvto edits, other defect implementation, dependency/provider/model changes, UI changes,
merge, rebase, push, deploy, release, spending, or `.loop/` mutation.

## Invariants

1. A newly accepted utility job has a current durable owner/recovery path or receives exactly one
   attributable route decision that moves it out of `pending-route`.
2. Missing lease holder, missing utility peer, missing router, stale epoch/authority, or no eligible
   capability cannot remain silently `pending-route` forever or be presented as healthy.
3. Temporary concurrency pressure is valid backlog: an otherwise eligible request may remain
   `pending-route` until a slot frees, then route exactly once.
4. Restart, replay, duplicate drain, and repeated admission preserve request idempotency and append
   at most one effective route decision or terminal event.
5. Existing driver, peer-review, utility-tier selection, D1 bridge safety, and D4 peer-response
   behavior remain unchanged outside the reproduced branch.

## Reproduction rule

Add the smallest deterministic named regression against unchanged base. Prove the no-owner case
with a durable `route-requested` row, no routing invocation/decision, and unchanged
`pending-route` state after a bounded Governess cycle or replay. Add controls for no eligible tier,
stale epoch, duplicate reconciliation, and a full-but-eligible pool that later recovers. If current
code already satisfies the invariant, record exact contrary proof and make no production edit.

## Compatibility

Prefer existing utility job states, route-decision schema, idempotency keys, and journal readers.
Do not introduce provider calls, broad routing-policy changes, unbounded timers, or synthetic
success. Old journals must remain readable; repeated processing must remain idempotent.

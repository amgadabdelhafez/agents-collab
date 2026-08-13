# D4 Live Peer Unconsumed Plan

## Approach

1. Audit utility state ownership, bridge dispatch/intake, response correlation, and existing tests.
2. Add the smallest deterministic regression at the existing utility-runtime/bridge boundary.
3. Run the unchanged regression against base `0822c3546c44521ea778324d66d6c4c98f3972fb` and record the
   decisive failure plus exact journal rows and controls.
4. Set the exact transition contract from evidence: owner, retry bound, live/dead/unknown behavior,
   terminal state, idempotency, and replay.
5. If reproduced, apply the smallest D4-only correction. If not, skip production changes and record
   exact contrary proof.
6. Re-run live, dead, unknown, duplicate wake/reconciliation, restart/replay, unrelated-target, and
   routed-driver/requester/utility controls.
7. Run affected files and mandatory repository verification; write both eval schemas.
8. Prove D4-only scope, commit explicit paths, and request Claude zero-write exact-SHA review.

## Evidence boundaries

- Liveness: exact current target evidence only.
- Notification: wake attempt only; never delivery proof.
- Delivery: durable bridge state for exact identity and target.
- Consumption: exact peer intake/acknowledgement.
- Completion: correlated durable utility terminal state.

## Rejected designs

- Treating `routed-peer`, bridge append, wake success, heartbeat, or pane prose as consumption.
- Unbounded retry or retention.
- Synthetic success for dead/unknown targets.
- Real tmux, provider calls, or sleeps in regression tests.
- Cross-defect cleanup or journal-incompatible event rewrites.

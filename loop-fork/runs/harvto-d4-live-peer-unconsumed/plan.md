# harvto-d4-live-peer-unconsumed Plan

Mode: emergent
Description: D4 P0: reproduce routed-peer messages remaining unconsumed while the exact target peer is live, then fix with delivery evidence.

## Objective

Reproduce whether work durably routed to an exact positively live peer can remain unconsumed, then
make consumption or a bounded durable terminal outcome replay-safe and observable without duplicate
dispatch or completion.

## Scope

- Utility `routed-peer` transition and durable journal reconstruction.
- Bridge append/delivery, exact-peer inbox consumption, response correlation, and reconciliation.
- Deterministic utility-runtime/bridge regression with restart/replay and duplicate controls.
- D4-only source, tests, Harness evidence, defect-matrix section, and repo-root eval.


## Proposed Tasks

### 1. Reproduce and settle contract

- [ ] Trace durable routing, notification, delivery, consumption, response, and terminal state.
- [ ] Add one deterministic regression and run it unchanged against base
  `0822c3546c44521ea778324d66d6c4c98f3972fb`.
- [ ] Record exact journal sequence and live/dead/unknown plus replay controls.

### 2. Fix only reproduced branch

- [ ] Assign bounded reconciliation ownership for transition out of `routed-peer`.
- [ ] Preserve exact target, ordering, dedupe, D1 liveness/retention, and journal compatibility.

### 3. Test and verify

- [ ] Run focused controls, affected files, check, canonical typecheck, build, and serial test suite.
- [ ] Write Harness and repo-root evals; pass stop-gate and `scripts/verify.sh`.
- [ ] Commit D4-only paths and obtain Claude zero-write `PASS` on exact SHA.

## Non-goals

- D1-D3 and D5-D14 changes.
- Harvto mutation, dependency/provider/model changes, UI work, remote operations, release, or deploy.
- Treating liveness, notification, or bridge append alone as consumption evidence.

# harvto-d4-live-peer-unconsumed

Task completed 2026-08-13T12:09:58Z, mode emergent.

## What was built

Added replay-safe reconciliation for durable `routed-peer` utility jobs. The runtime now repairs the
state-transition-before-dispatch crash window with a stable bridge dedupe key, waits for exact
request delivery plus a correlated reverse peer response, completes once with the peer result, and
fails once when the bridge records an existing durable terminal resolution.

Added deterministic controls for a positively live Claude peer, exact inbox consumption and
response correlation, dispatch replay, duplicate suppression, unknown liveness, dead-letter
failure, unrelated traffic, and epoch restart. Updated D4-only specifications, evidence, evals,
matrix status, and handoff records.

Coupled the result-bearing consumer to its producer by requiring the peer review instruction to
return the verdict with bridge message type `decision`; acknowledgements and generic or
legacy-untyped progress remain nonterminal.

## Decisions made

- Promoted parked idea `specs/harvto-d4-live-peer-unconsumed.md` into active task `harvto-d4-live-peer-unconsumed`.
- Assigned durable `routed-peer` reconciliation to `processPendingUtilityRoutes` with stable request
  dedupe and exact delivery/response correlation.
- Required the producer to request bridge type `decision` and kept acknowledgements, generic
  messages, and legacy-untyped progress nonterminal.
- Preserved D1 bridge liveness, retention, and queue policy; live or unknown liveness alone never
  synthesizes terminal success or failure.

## Open items at completion

- None within D4. D2-D3 and D5-D14 remain explicitly out of scope for this task.

## Trajectory

- 001 - initial (2026-08-13T08:42:39Z)
- 002 - promoted parked idea (2026-08-13T08:42:39Z)

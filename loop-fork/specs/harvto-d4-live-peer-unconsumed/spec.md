# D4 Live Peer Unconsumed

## Goal

Ensure a utility request durably routed to an exact positively live peer reaches peer-visible
consumption and a correlated durable result, or reaches a bounded explicit terminal outcome. A
`routed-peer` decision, wake notification, or bridge append alone is not consumption evidence.

## Scope

- `src/loop/utility-store.ts` durable utility job states and journal reconstruction.
- `src/loop/utility-runtime.ts` peer routing, bridge append, retry, and reconciliation.
- Exact-peer intake and response correlation in current native-subagent/bridge boundaries.
- Existing utility-runtime/worker test boundary selected by source tracing.
- D4-only Harness evidence, defect-matrix section, evals, `PLAN.md`, and `status.md`.

No Harvto edits, D1-D3 or D5-D14 work, dependency/provider/model changes, UI changes, merge,
rebase, push, deploy, or release.

## Invariant

1. A durable `routed-peer` transition names one exact target and correlation identity and remains
   recoverable until peer consumption plus correlated terminal result, explicit cancellation, or a
   bounded terminal failure backed by durable evidence.
2. Positive liveness permits delivery attempts but does not prove notification, delivery,
   consumption, acknowledgement, response, or completion. Each is separate evidence.
3. Dead, unknown, missing, malformed, or stale liveness evidence cannot synthesize consumption or
   success. These states fail closed and remain bounded through explicit retry/terminal policy.
4. Restart, wake races, reconciliation, repeated reads, and duplicate responses produce at most one
   effective peer dispatch and one terminal utility resolution for the request identity.
5. D1 bridge retention, exact-pane liveness, ordering, dedupe, acknowledgement, and journal
   compatibility remain unchanged.

## Reproduction rule

The first test must fail unchanged base `0822c3546c44521ea778324d66d6c4c98f3972fb` at the current
utility-runtime/bridge seam while proving exact target, positive live evidence, durable journal
sequence, missing consumption or terminal state, restart/replay behavior, and no unrelated target
activity. If the invariant already holds, record `already-fixed` or `not-reproduced` and do not
change production code.

## Compatibility

Prefer existing journal event kinds and optional fields. Pre-D4 journals must reconstruct under the
fixed runtime. Fixed journals must remain parseable by readers that ignore optional unknown fields.
No notification or heartbeat signal may be promoted into delivery or consumption authority.

## Settled transition contract

- `processPendingUtilityRoutes` owns reconciliation of durable `routed-peer` jobs on each Governess
  cycle and after restart.
- The original peer request is the bridge `review_request` whose `taskId` equals the job ID and
  whose source/requester and exact target peer match the route decision. Its producer instruction
  requires the peer to return its verdict with bridge message type `decision`, matching the only
  result-bearing consumer type.
- Missing request append after a routed-state crash window is re-created with a stable dedupe key;
  repeated reconciliation produces one effective request message.
- A peer response is correlated by the same job `taskId`, exact reverse source/target, and request
  identity when `replyTo` is present. Because legacy missing types normalize to `message` on read,
  only an explicit `decision` is result-bearing for a peer review. `ack`, `message`, `handover`, and
  untyped legacy rows prove neither a verdict nor completion and keep the job recoverable.
  Notification or request delivery alone also does not imply a verdict.
- One correlated response records one deterministic `completed` result carrying the peer summary
  and artifacts. Reconciliation/replay appends no second terminal event.
- Bridge terminal resolution backed by its existing D1 liveness policy may fail the route. Live or
  unknown liveness without response remains recoverable; utility code does not reinterpret either
  state as consumption, failure, or success.
- If D1 queue pressure returns pre-append `backpressure`, D4 makes no tight-loop retry: one dispatch
  attempt occurs per later Governess reconciliation cycle. The utility job remains recoverable and
  bridge-owned retained-queue bounds remain authoritative.

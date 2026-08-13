# D3 Pending Route Plan

## Approach

1. Confirm exact base, canonical task identity, active Harness state, and preserved `.loop/`.
2. Trace `route_task` admission through durable request storage, Governess drain ownership,
   deterministic route selection, and route-decision persistence.
3. Add one named exact-base regression for a pending job when Governess lacks a current routing
   owner. Record the durable journal and decisive red assertion before production changes.
4. Prove controls for no eligible tier, stale epoch, duplicate reconciliation, unrelated routing,
   and full-but-eligible capacity recovery.
5. Implement the smallest fail-closed correction at the owner established by reproduction. Reuse
   current route decisions and idempotent transitions.
6. Re-run focused D3 tests plus D1/D4 bridge and utility controls.
7. Run static checks, canonical TypeScript, build, serial full suite, Harness gates, and root
   verifier with both required eval schemas.
8. Derive complete scope from Git, commit explicit D3 paths, and obtain Claude zero-write `PASS`
   on the exact SHA. Apply only D3 corrections if review returns `REVISE`.
9. Close Harness once after `PASS`, commit explicit lifecycle bookkeeping, then continue to D5.

## Candidate implementation seams

- `src/loop/governess.ts`: currently invokes pending-route processing only when run directory,
  workspace, lease holder, and utility peer are all present.
- `src/loop/utility-runtime.ts`: owns deterministic route decisions, valid capacity backlog, stale
  epoch rejection, and replay.
- `src/loop/utility-store.ts`: owns durable idempotent route-request and route-decision transitions.
- `src/loop/bridge-utility.ts`: admission remains a candidate only if reproduction proves it can
  reliably determine current routing ownership without widening policy.

## Rejected designs

- Rejecting all `pending-route` responses regardless of recoverable owner or capacity.
- Treating a full eligible pool as permanent unavailability.
- Adding provider/model fallback, paid utility use, broad worker-pool policy, or timer polling.
- Synthetic success, silent deletion, duplicate terminal events, or non-durable error reporting.
- Mixing D5-D16 implementation into the D3 change.

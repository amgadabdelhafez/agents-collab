# Workflow engine selection for SupervisorMessage

Status: accepted candidate pending independent review

Decision ID: ORCH-SELECT-001

Date: 2026-08-30

## Decision

Use Temporal as the durable workflow engine behind the engine-neutral
`WorkflowPort` for `SupervisorMessage`.

Keep the DBOS adapter and its evidence as a maintained comparison artifact. Do
not configure it as a live fallback for this workflow contract. A fallback that
cannot recover the same pending workflow identity across the required named
application-version boundary would silently weaken the contract.

## Exact evidence boundary

| Evidence | Accepted closure | Result |
|---|---|---|
| Engine-neutral port and reference workflow | `3b40b16ea11ef298a42aa5f7e2830e9fc10afeaf` | Canonical identity, idempotency, history, claim, acknowledgement, retry, escalation, dead-letter, cancellation, and JSON-safe projection contract |
| Frozen six-case replay corpus | `aa6bff5c11d478ff8d15aee702c6903aa7e7fab4` | Exact per-case observations and aggregate digest `5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd` |
| Temporal 1.23.0 adapter | `ebdd8707a3192315ff28d96eea2ba2d5ef7cd47e` | All six cases completed twice on fresh real Temporal CLI 1.8.2 / Server 1.31.2 test servers with the frozen aggregate digest |
| DBOS 4.27.6 comparison | `852e485af7b926de64d6e5f83bf5766323a7977f` | First five exact digests matched with real same-version worker-process recovery; the v1 workflow remained `PENDING` and the named v2 worker timed out the exact command |

All four closures include independent zero-project-write exact-SHA review. The
selection uses those accepted artifacts; it does not infer behavior from a
green aggregate label or from producer prose.

## Why Temporal satisfies this contract

The required contract includes one stable workflow identity surviving process
loss and a named worker application-version upgrade. Temporal preserved that
identity and completed every unchanged replay case, including the upgrade case,
with exactly the frozen observations and aggregate digest.

DBOS demonstrated correct behavior for duplicate receive, crash retry, delayed
claim, cancellation replay, and retry exhaustion. Under the distinct version
named by the frozen sixth fixture, DBOS correctly retained the prior workflow
as a v1 `PENDING` record, but the v2 worker did not recover it and the bounded
claim command timed out. Relabeling a same-version restart as an upgrade,
forking a new workflow ID, or draining every old-version workflow before an
upgrade would change the accepted contract rather than satisfy it.

This is a scoped selection, not a universal engine ranking. DBOS may remain
appropriate for workflows whose deployment and lifetime contract does not
require this cross-version pending-workflow continuity.

## Architecture consequences

- Canonical workflow code, `SupervisorMessage`, fixtures, and consumers depend
  only on `WorkflowPort`; Temporal SDK types remain in adapter/runtime modules.
- `ORCH-GOV-001` may implement the durable production path with the accepted
  Temporal adapter and must not duplicate workflow state in the message board,
  Attention projection, or KB read models.
- DBOS stays non-production comparison evidence. Any future DBOS reconsideration
  requires an independently accepted adapter that passes the same unchanged
  corpus, including the version-upgrade case.
- A future engine replacement is an adapter and migration decision. It must
  preserve workflow IDs, command receipts, immutable history, and projection
  semantics, then pass the frozen corpus before live migration is proposed.

## Production gates not granted by this decision

This decision does not provision or deploy Temporal. Live use still requires:

- an exact deployment topology and namespace/task-queue ownership model;
- short-lived workload identity and scoped authorization;
- credential issuance and secret-delivery evidence;
- retention, backup, recovery, and versioning policy;
- metrics, traces, alerts, and operator recovery procedures;
- one staged cross-supervisor proof with Governess receipts; and
- fresh exact-target deployment authority.

Until those gates close, the selected adapter is implementation authority only,
not production deployment authority.

# D6 Plan

1. Freeze this contract under Claude literal zero-write `PLAN PASS` before any source or regression
   edit. Record the exact base and SHA-256 of spec, plan, tasks, and verify.
2. At unchanged production base, add only the named fixture-owned regression `D6 read-only
   target-window client does not block Claude suggested-composer recovery`. Preserve its exact
   command, decisive failure, synthetic pane snapshot, exact target identity, client records, and
   zero-key observation under `runs/harvto-d6-readonly-attach/artifacts/red/`; never recapture it.
3. Extend the pane-bound snapshot with exact identities from `window_active_clients_list`, encoded in
   a separate unambiguous field or record line so the existing fixed-arity marker remains valid.
   Intersect those identities with per-client `client_readonly` records from a session-bound
   `list-clients` query. Set equality by identity proves membership; the active-client count is only
   a fail-closed cross-check. Never infer target-window membership from count equality.
4. Make the same positively read-only classifier own both current consumers: the initial
   `matchesClaudeSuggestionSnapshot` gate and the post-send changed-suggestion branch that currently
   checks raw `observed.activeClients === 0`. A stable new suggestion returns `candidate-changed`
   under read-only viewers; unknown or unsafe evidence remains a post-send error.
5. Require stable before/after client identity and mode around the existing suggested-composer
   probe. A writable record, unknown/malformed or extra-arity output, command failure/timeout,
   missing intersection member, duplicate, count mismatch, target mismatch, or changed set returns
   indeterminate and sends zero keys. Keep pipe, cursor, activity, and composer checks intact.
6. Give the synthetic `capturePane` shim explicit safe empty-set semantics: count zero, pane identity
   set empty, and matched mode set empty. Any positive count with absent/empty identity or mode
   evidence is unsafe; missing evidence never passes through vacuous `every()`.
7. Add named controls for read-only success, read-only changed-suggestion reclassification, writable
   rejection, malformed/extra-arity/unknown fail-closed, client-set race rejection, other-window
   isolation, explicit empty-set and synthetic-shim behavior, piped-pane rejection, human-draft
   preservation, and replay after acknowledged empty state. Assert the exact default query shape,
   while recording that injected results do not certify deployed tmux output.
8. Run focused and mandatory verification, both eval schemas, Harness gates, and root verifier.
   Reconcile Git-derived scope, commit only `src/loop/tmux.ts` and `tests/loop/tmux.test.ts`, obtain
   Claude exact-SHA literal `PASS`, close Harness once, and commit lifecycle/evidence separately.

If the exact-base regression does not fail through the stated client-count branch, record
`not-reproduced` evidence and make no production edit. Do not widen D6 into Governess durable
transport; that remains D11.

# harvto-d16-scope-audit-completeness Plan

Mode: emergent
Exact base: `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`

## Objective

Make scope-audit results carry deterministic Git-derived path evidence that cannot be silently
weakened by helper synthesis. A consumer must verify canonical count and SHA-256 before treating an
audit as complete or clean.

## Scope

- Utility scope-audit broker/runtime/result boundaries selected by exact-base reproduction.
- Added/untracked, deleted, renamed/copied, staged, unstaged, committed-range, and tracked
  routing-ignored path classes.
- Consumer-side count/hash/path reconciliation and durable replay.
- D16-only source, tests, contracts, evidence, evals, matrix hunk, plan, and status.


## Proposed Tasks

### 1. Preserve and reproduce the observed false negative

- [ ] Record run-60 jobs `3466ccae-7ca4-4eb9-be18-b645a77aa019` and
      `6747f5a7-f35a-446d-9690-3b7f64feed42` as read-only historical evidence.
- [x] Add one named exact-base regression where broker evidence contains known modified paths but
      synthesized scope output omits one and still completes/looks clean.
- [ ] Cover each required path class and preserve the decisive red result before production edits.
- [x] Evaluate the contrary-proof branch. Current production decisively completed without any
      authoritative scope manifest, so the `not-reproduced` exit does not apply.

### 2. Implement the narrow fail-closed contract

- [ ] Produce one canonical sorted path manifest with path states, count, and SHA-256 from Git truth.
- [ ] Keep model prose advisory; make the result consumer validate manifest count/hash/path
      normalization before accepting a complete or clean audit.
- [ ] Treat missing, duplicate, malformed, truncated, or mismatched evidence as failed/unknown,
      never clean. Preserve legacy non-scope utility replay.

### 3. Test and verify

- [ ] Prove every required path class, clean negative control, model omission, mismatch/tamper,
      protected tracked-path metadata, and replay/idempotency behavior.
- [ ] Run focused utility broker/runtime/store/router/bridge controls, then check, canonical
      typecheck, build, complete serial `test:ci`, both eval schemas, Harness gates, and root verifier.
- [ ] Prove Git-derived exact scope, commit explicit D16 paths, obtain Claude zero-write exact-SHA
      `PASS`, close Harness once, and commit lifecycle bookkeeping before D15.

## Non-goals

- D15 or D6-D12 implementation, helper/model quality work outside scope audits, provider or model
  changes, utility routing/spend, Harvto access, dependency changes, UI work, merge, rebase, push,
  deploy, release, or root `.loop/` mutation.

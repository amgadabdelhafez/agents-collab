# D16 Complete Scope Audit Evidence Plan

Exact base: `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`

## Phase 1 — Trace and reproduce

1. Preserve the two run-60 false-output records with their request/result and usage provenance.
2. Trace `git-status`/`git-diff` broker output through utility synthesis, compact result persistence,
   bridge notification, and result consumption.
3. Add the smallest named test that supplies a known Git/broker path set, omits one in synthesized
   output, and proves current code still records an authoritative-looking completion.
4. Save exact red evidence before changing production. If it already fails closed, record
   `not-reproduced` and stop source work.

## Phase 2 — Narrow implementation

1. Define canonical path records for all required Git surfaces and states.
2. Attach deterministic count/hash evidence at the broker/runtime boundary without trusting model
   prose or exposing protected file contents.
3. Validate the evidence at the consumer boundary before complete/clean is accepted.
4. Preserve replay and legacy non-scope result compatibility.

## Phase 3 — Verification and closure

1. Run focused broker/runtime/store/execution-tier/router/bridge tests.
2. Run `bun run check`, canonical typecheck, `bun run build`, and full serial `bun run test:ci`.
3. Produce passing Harness and repository-root eval schemas with empty baseline failures; pass
   Harness preflight/stop-gate and `scripts/verify.sh`.
4. Reconcile the D16 path set from Git, stage explicit files, commit, and obtain Claude zero-write
   `PASS` for the exact SHA.
5. Close Harness once, inspect and commit bookkeeping, then promote D15 separately.

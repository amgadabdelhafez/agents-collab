# Plan: Au Pair small-code delegation

1. Encode the safe small-edit boundary in the pure request validator and keep
   `kind: "edit"` deterministically mapped to Au Pair.
2. Add concise edit-first and operational-risk guidance to the shared paired
   prompt, Claude channel instructions, and `route_task` schema descriptions.
3. Tell main agents to reserve exact write scopes, keep non-overlapping work in
   flight, review proposal artifacts, and use guarded apply only after review.
4. Add prompt, schema, routing, and negative-boundary regression tests.
5. Run focused tests, repository checks, the full fail-closed verifier, and an
   independent exact-commit review before any runtime integration.

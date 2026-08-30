# Plan: SupervisorMessage board and Attention projections

1. Add a pure, engine-neutral read model over
   `SupervisorMessageProjection`; do not read workflow internals.
2. Validate the complete projection boundary, including strict schema,
   identities, timestamps, action, phase, counters, and artifact references.
3. Derive deterministic board and Attention snapshots from one keyed state.
4. Add focused tests for validation, deduplication, ordering, defensive copies,
   body/path exclusion, and Attention membership.
5. Add one integration proof using the governed service, reference workflow
   port, and real bridge JSONL transport across two supervisor identities.
6. Run one focused gate, one full suite, static/build/diff gates, freeze, and
   obtain independent zero-write exact-SHA review.

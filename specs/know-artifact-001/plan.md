# Plan: KB artifact-reference read model

1. Add one pure engine-neutral projector over the board projection boundary.
2. Strictly validate the top-level and nested field sets before deriving data.
3. Group content-addressed references and emit deterministic message backlinks.
4. Add direct tests for grouping, ordering, idempotence, defensive output,
   malformed input refusal, and forbidden-field absence.
5. Run focused, one full, static/build/diff gates, freeze, and obtain independent
   zero-write exact-SHA review.

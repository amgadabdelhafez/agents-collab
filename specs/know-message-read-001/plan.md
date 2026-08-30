# Plan: durable knowledge artifact read model

1. Add a durable knowledge reader to the existing knowledge artifact module.
2. Delegate source reading and grouping to the accepted durable artifact view.
3. Map only safe deterministic fields into the knowledge schema.
4. Test restart, lifecycle replacement, corruption, defensiveness, and explicit
   transcript/local-path absence.
5. Run focused, one full, static/build/diff gates, freeze, and obtain independent
   zero-write exact-SHA review.

# Plan: selective durable supervisor Attention

1. Add one projector whose source is a nominal `JsonlSupervisorThreadStore`.
2. Fresh-read the journal and select only the four contracted categories.
3. Emit deterministic body-free items with current lifecycle state.
4. Test all five categories, acknowledged selection, lifecycle replacement,
   restart, defensiveness, and corrupt-journal refusal.
5. Run focused, one full, static/build/diff gates, freeze, and obtain independent
   zero-write exact-SHA review.

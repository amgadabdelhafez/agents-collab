# Plan: durable supervisor artifact references

1. Add one projector whose source is a nominal `JsonlSupervisorThreadStore`.
2. Read the journal afresh and group latest durable message references.
3. Emit deterministic body-free backlinks with immutable message categories.
4. Test restart, lifecycle replacement, ordering, defensiveness, corruption,
   and forbidden-field absence.
5. Run focused, one full, static/build/diff gates, freeze, and obtain independent
   zero-write exact-SHA review.

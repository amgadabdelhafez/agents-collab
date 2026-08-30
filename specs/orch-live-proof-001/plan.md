# Plan: operational Temporal orchestration proof

1. Expose `TaskGraphRuntime` and an authenticated handler factory from
   `TemporalSupervisorRuntimeHost` using its single shared `TemporalWorkflowPort`.
2. Add one real-Temporal integration test covering governed message delivery,
   durable projections, DAG dependency readiness, worker ownership, receipts,
   and terminal completion.
3. Run the focused proof, static/build/diff gates, one complete suite, freeze an
   exact candidate, and obtain an independent zero-project-write review.


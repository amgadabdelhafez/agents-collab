# Plan: DBOS WorkflowPort adapter

1. Pin the current stable DBOS TypeScript SDK and use an isolated PostgreSQL
   database with no production connection.
2. Register one DBOS workflow that processes persisted command messages and
   publishes queryable state/outcome events.
3. Implement `DbosWorkflowPort` over stable workflow IDs, durable sends, and
   bounded event/status reads while keeping public types engine-neutral.
4. Implement the replay runtime with an actual child worker process, hard
   process-loss/relaunch over a stable executor identity, distinct application
   versions, deterministic injected delivery outcomes, and cleanup. A graceful
   `DBOS.shutdown()` is not a crash simulation for a waiting workflow.
5. Execute the unchanged frozen corpus in order. Require exact per-case digests
   until completion or a positively identified engine-level refusal; never
   substitute same-version recovery for the frozen version-upgrade step.
6. Run focused/full/static gates, freeze one exact candidate, and obtain an
   independent zero-write exact-SHA review.

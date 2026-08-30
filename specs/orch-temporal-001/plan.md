# Plan: Temporal WorkflowPort adapter

1. Add exact Temporal TypeScript SDK client, worker, workflow, and testing
   packages only.
2. Implement a workflow-local command processor that mirrors the accepted
   `WorkflowDefinition` transition rules and exposes signal/query handlers.
3. Implement `TemporalWorkflowPort` as an engine adapter whose public surface is
   only the canonical `WorkflowPort` contract.
4. Implement a replay runtime over `TestWorkflowEnvironment` with explicit
   worker stop/restart and changed build identity on upgrade.
5. Execute the unchanged frozen corpus and reject any case or aggregate digest
   mismatch.
6. Add failure-path teardown and boundary tests, then run focused/full/static
   gates and independent exact-SHA review.

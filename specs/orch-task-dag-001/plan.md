# Plan: canonical task dependency DAG

1. Define and strictly parse the bounded machine-readable graph and node schema.
2. Validate graph topology and write-scope ordering before workflow creation.
3. Implement authority-gate, claim, start, completion, failure, cancellation,
   readiness, blocker, and terminal-state transitions.
4. Register the canonical definition in both reference and Temporal execution.
5. Test invalid graphs, deterministic readiness, exact receipts, failure
   propagation, independent branches, replay, and real Temporal execution.


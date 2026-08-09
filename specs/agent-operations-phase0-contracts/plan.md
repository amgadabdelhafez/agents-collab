# Phase 0A Plan

1. Inventory existing identifier and envelope conventions only far enough to
   prevent incompatible duplication.
2. Design one small contract module with explicit schema versions and pure
   validation functions.
3. Implement the module in one edit batch.
4. Add one focused regression file: valid round-trip plus cross-lane rejection.
5. Run the focused test, scoped typecheck/check, build smoke, and diff check.
6. Write `runs/agent-operations-phase0-contracts/eval.json`, request one native
   zero-write review, commit only the bounded slice, and stop.

No successor loop, helper edit delegation, broad test matrix, service install,
merge, global install, or remote push is part of this plan.

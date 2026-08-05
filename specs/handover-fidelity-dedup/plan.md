# Plan: Handover Effort Fidelity and Governess Restart Reconciliation

1. Extend the frozen handover manifest with validated effort and continuation
   metadata derived from the predecessor run.
2. Feed only the validated manifest effort values into replacement launch
   arguments.
3. Add a one-time initial-frame reconciliation sequence while preserving the
   steady-state line-delta renderer.
4. Add producer-backed regressions for effort carry, artifact tampering, and a
   stale pre-restart terminal frame.
5. Update the Governess runtime contract and debt register for the adopted
   teardown-first model and retired crisis commit.
6. Run focused and full verification, commit the exact candidate, request
   stamped exact-SHA supervisor review, and stop at the review gate.

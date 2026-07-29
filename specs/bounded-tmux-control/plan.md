# Plan

1. Inventory every synchronous tmux call and classify attach, observation,
   mutation, and launch behavior.
2. Add one shared timeout policy and tri-state liveness result.
3. Make bridge and proxy paths preserve queued/owned state on unknown.
4. Make launch/resume and Governess lifecycle paths bounded and fail-safe.
5. Add adversarial timeout tests, run focused/full verification, build once,
   and request an exact-SHA review before deployment.

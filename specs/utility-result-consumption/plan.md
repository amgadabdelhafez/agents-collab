# Plan: Utility Result Consumption

1. Reproduce the split state with a real durable utility job and its queued
   handover.
2. Reuse the bridge inbox consumer when `get_task_result` returns the job,
   bounded to the exact caller and task.
3. Prove unrelated, claimed, and supervisor-owned delivery paths remain
   pending.
4. Run focused bridge tests, the build, mandatory verification, and diff
   checks before requesting exact-SHA review.

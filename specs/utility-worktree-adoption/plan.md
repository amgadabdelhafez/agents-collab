# Plan: Utility Worktree Adoption

1. Trace route-task creation, router context, durable job schema, detached
   worker startup, and tool-root construction.
2. Add a Git-verified request-workspace resolver at the runtime boundary.
3. Persist and reuse the verified workspace root through routing, execution,
   tool brokering, and guarded apply.
4. Add same-repository linked-worktree success and unrelated/mixed-root failure
   regressions.
5. Verify, independently evaluate, integrate locally, and prove one live loop
   47 worktree request without touching Claude or Codex.

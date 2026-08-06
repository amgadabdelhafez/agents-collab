# Worktree Reaper Hardening Plan

1. Implement a standard-library Python command with NUL-safe Git porcelain
   parsing and structured candidate results.
2. Inventory process current-working-directories once with `lsof`, then
   compare paths component-wise so nested directories count as in use.
3. Re-run Git cleanliness, ancestry, and process checks immediately before
   each applied removal; rely on non-force `git worktree remove` as the final
   dirty-worktree guard.
4. Add producer-backed tests that create real temporary Git repositories,
   commits, branches, linked/detached worktrees, dirty state, paths with
   spaces, and a live process rooted below a worktree.
5. Run focused tests, repository checks, the complete certified suite, and
   Harness preflight/stop gates. Commit and request exact-SHA review without
   merging or deploying.

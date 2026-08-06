# Worktree Reaper Hardening Verification

## Focused acceptance

Producer-backed tests must prove:

- dry run reports but does not remove an eligible worktree;
- apply removes only a clean worktree whose exact HEAD is merged into the
  resolved base;
- dirty tracked and untracked worktrees remain;
- unmerged worktrees remain;
- detached merged worktrees are discovered and can be reaped;
- a path containing spaces is parsed and handled correctly;
- a live process whose cwd is a nested directory keeps the worktree;
- an unresolved base and a failed process inventory return nonzero without
  removing anything;
- the primary worktree is never a candidate;
- apply-time state changes fail closed; and
- no branch is deleted.

## Repository gates

- Focused reaper tests pass with an empty failure set.
- `cd loop-fork && bun run check` passes.
- `cd loop-fork && bun run build` passes.
- `cd loop-fork && bun run test:ci` passes with an empty failure set.
- Harness preflight and stop-gate pass for `worktree-reaper-hardening`.

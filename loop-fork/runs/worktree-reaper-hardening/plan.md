# Worktree reaper hardening plan

## Contract

- Dry-run by default; `--apply` is the only mutation switch.
- Remove only a non-primary worktree whose exact HEAD is merged into the
  resolved base, whose tracked and untracked status is clean, and whose path
  contains no process cwd.
- Treat unknown state as KEEP or a visible nonzero failure.
- Never force removal or delete branches.

## Implementation

- Parse `git worktree list --porcelain -z` so detached and spaced paths remain
  visible.
- Default the integration proof to the exact `origin/main` commit.
- Inventory process cwd paths with `lsof` and compare path components so nested
  cwd locations count as in use.
- Re-run every safety check immediately before each applied removal.
- Prune only stale registrations and only in apply mode.

## Verification

- Producer-backed temporary repositories cover each keep/remove boundary.
- A display-only audit exercises the command against the real registered set.
- Static check, typecheck, build, complete certified suite, Harness preflight,
  and Harness stop-gate must pass.

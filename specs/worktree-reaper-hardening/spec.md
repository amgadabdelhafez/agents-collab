# Worktree Reaper Hardening

## Problem

The existing `chore/worktree-reaper` prototype is a single untested shell
script based on an old repository lineage. It can miss detached worktrees,
uses a possibly stale local `main`, and does not prove that no process has a
working directory below the candidate worktree.

The repository has many concurrent linked worktrees. Cleanup must therefore
fail closed: uncertainty keeps a worktree and surfaces the reason.

## Required behavior

Add a repository-local `scripts/reap-worktrees.py` command that:

1. defaults to a display-only audit and mutates only with `--apply`;
2. derives every registered worktree from `git worktree list --porcelain -z`,
   including detached and stale registrations and paths containing spaces;
3. never removes the primary worktree;
4. resolves and reports the exact base commit, defaulting to `origin/main`, and
   exits nonzero before cleanup if the base cannot be resolved;
5. considers a present linked worktree reapable only when its exact HEAD is an
   ancestor of the base, its status is clean including untracked files, and no
   live process has a current working directory at or below it;
6. treats Git, status, process-inventory, and revalidation failures as KEEP or
   fatal preflight outcomes, never as permission to remove;
7. revalidates eligibility immediately before each applied removal and never
   uses force;
8. reports stale registrations separately and lets `git worktree prune`
   process them only in apply mode;
9. does not delete branches; and
10. emits a deterministic summary suitable for post-merge hygiene reporting.

## Non-goals

- Killing processes or restarting loops.
- Removing dirty, unmerged, locked, or uncertain worktrees.
- Fetching remotes or deciding which remote branch is authoritative.
- Deleting local or remote branches.
- Running cleanup automatically during deployment.

## Authority and safety

The script is an operator tool. Dry-run output is evidence only. `--apply` is
an explicit local deletion request, but each target must still pass every
producer-backed check. A failed or missing safety instrument is a fail-closed
error.

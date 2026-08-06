# Task worktree-reaper-hardening

Created: 2026-08-06T01:11:42Z
Mode: maintenance
Description: Fail-closed, producer-tested cleanup and reporting for registered Git worktrees

## What I changed

- Added `scripts/reap-worktrees.py`, a dry-run-by-default cleanup command based
  on NUL-delimited Git porcelain.
- Added fail-closed exact-base, merged-HEAD, tracked/untracked cleanliness,
  locked-registration, and nested-process-cwd checks.
- Added apply-time revalidation, non-force removal, stale-registration prune,
  deterministic reporting, and branch preservation.
- Added eight producer-backed tests using real temporary repositories,
  commits, branches, linked and detached worktrees, dirt, locks, stale paths,
  path spaces, and a live nested-cwd process.
- Added the root spec/plan/tasks/verify slice and operator documentation.

## Why

The older `310869e` prototype was 204 commits behind current `origin/main`,
untested, skipped detached worktrees, defaulted to possibly stale local
`main`, and did not prove that a process cwd below a worktree was absent.

## Notes

Verification on the current source tree:

- `bun run test:file -- tests/worktree-reaper.test.ts`: 8 pass, 0 fail, 38
  expectations.
- Display-only real repository audit: 98 linked registrations scanned, 60
  reapable, 38 kept, 0 stale, 0 failed, and 0 removed.
- `bun run check`: pass, 827 files, no fixes required after formatting.
- repository TypeScript no-emit command: pass.
- `bun run build`: pass.
- `bun run test:ci`: complete sorted suite pass with an empty failure set.
- No worktree cleanup was applied. No branch was deleted. No binary was
  installed or deployed.

# Task active-launch-interlock

Created: 2026-07-31T16:45:17Z
Mode: planned
Description: Reject concurrent paired launches bound to the same active worktree and branch

## What I changed

- Opened an isolated worktree from deployed-line closure `bd93a58`.
- Added the root feature spec, plan, tasks, and evaluator contract before code
  changes.
- Added a structured canonical workspace binding with an explicit
  `--workspace` option, registered-worktree validation, full symbolic branch
  identity, and invocation-relative Markdown prompt preservation.
- Added a repository-scoped launch lock, exclusive numeric run-directory
  reservation, immutable claim and charter hashes, atomic manifest replacement,
  fail-closed conflict classification, and explicit-resume reuse.
- Threaded reserved run ownership through paired startup and limited tmux
  failure cleanup to sessions positively created by the current invocation.
- Added focused process-concurrency, lifecycle, legacy, worktree, manifest,
  CLI-ordering, and tmux-race regression tests.

## Why

Runs 106 and 107 were launched 24 seconds apart against the same Harvto
worktree/branch. Existing state persisted only invocation cwd and allocated run
ids non-atomically, so neither launcher could see the other as a conflict.

## Notes

Regression: yes
Regression id: paired-launch-singleflight
Regression symptom: Two authorized launchers can create independent agent pairs that write one worktree; a racing failed cleanup can kill the winner.
Regression guard: tests/loop/launch-reservation.test.ts and exact-binary compiled smoke

Live `harvto-loop-106` is outside the test surface and must not be restarted or
mutated.

## Verification so far

- `bun run check`: pass.
- Focused changed-surface suite: 245 pass, 0 fail; subsequent CLI-only update:
  38 pass, 0 fail.
- `bunx tsc --noEmit ...`: pass.
- `bun run build`: pass.
- `bun run test:ci`: pass outside the filesystem/network sandbox. A prior
  sandboxed attempt failed only because loopback server binding was denied;
  the exact proxy integration test passed once run with loopback authority.
- `evals/smoke/active-launch-interlock.sh`: pass with an isolated HOME,
  isolated tmux socket, fake Gemini/Cursor TUI agents, and a 10,296-byte
  charter. Barrier result was one winner/one nonzero conflict; a distinct
  registered worktree then launched, yielding two live sessions and two
  manifests on different branches.

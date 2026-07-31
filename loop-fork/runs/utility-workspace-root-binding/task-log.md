# Task utility-workspace-root-binding

Created: 2026-07-31T03:11:23Z
Mode: planned
Description: Bind helper packets explicitly to a verified registered worktree without broadening file authority

## What I changed

- Authored the feature spec, plan, task list, and verifier contract before code.
- Root cause is established from run-102 evidence: 9/9 edit packets bound to the
  canonical checkout while the target files lived in a registered linked worktree.

## Why

The existing resolver already permits exact missing write targets and already
verifies registered linked worktrees. The missing capability is an ergonomic,
explicit way to select that verified root while keeping scopes repo-relative.

## Notes

Regression: yes
Regression id: utility-workspace-root-binding
Regression symptom: Helper edit packets reject or read missing files when the driver works in a linked worktree and submits repo-relative scopes.
Regression guard: tests/loop/utility-workspace.test.ts plus bridge and utility-tools focused tests

## Independent review history

- Initial verdict: DISSENT. The reviewer reproduced five release-blocking
  defects: registered-root symlink laundering, persisted-root retargeting before
  worker/apply, verifier commands that could exit zero with no tests, dangling
  symlink acceptance, and protected-path reason drift.
- Corrective implementation: registered roots and adopted roots must remain
  exact canonical non-symlink directories; path discovery uses `lstat`; resolver
  failures carry a typed reason; the verifier uses `bun run test:file --` and
  `bun run test:ci`.
- Final exact-diff verdict: CONCUR. The original reviewer reran the hidden
  `.git` alias end-to-end repro; the decision was `protected-scope` and worker
  spawn count was zero. All five original blockers are closed.

## Verification in progress

- Focused suites: task router 69/69, workspace 24/24, bridge guidance 7/7,
  bridge 91/91, utility runtime 50/50, utility tools 41/41.
- Repository `bun run test:ci`: pass.
- `bun run check`, `bun run build`, and `git diff --check`: pass.
- The sandboxed first utility-runtime run could not bind ephemeral localhost
  ports; the exact suite passed 50/50 outside the network sandbox. This is an
  environment restriction, not an accepted baseline failure.

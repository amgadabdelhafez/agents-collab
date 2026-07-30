# Task loop102-launch-hardening

Created: 2026-07-30T19:58:05Z
Mode: planned
Description: Make Claude bootstrap wait for positive prompt readiness and give detached paired tmux sessions usable default geometry.

## What I changed

- Started from exact deployed source lineage `8c2c83b` in isolated worktree
  `/private/tmp/agents-collab-loop102-launch-hardening`.
- Banked run-102 evidence for the swallowed Claude bootstrap and detached
  `80x24` session.
- Replaced stable-output settling with a positive empty-composer gate. Known
  trust, development-channel, and bypass prompts are handled once; a pane that
  never reaches the composer fails closed after 20 seconds before any bootstrap
  transport.
- Added a paired-only `220x60` detached fallback while preserving valid terminal
  dimensions and leaving single-agent launches unchanged.
- Extended the exact-binary smoke with a delayed Claude confirmation fixture, a
  never-ready failure case, and full eight-pane detached geometry floors.
- Verified `tests/loop/tmux.test.ts` (76 pass), `bun run check`, the isolated
  source smoke, and the complete `bun run test:ci` suite. The first sandboxed
  full-suite attempt could not bind a loopback test port; the same focused test
  and full suite passed outside the socket-restricted sandbox.
- Initial source freeze `85cd32d` was superseded before review after local QA
  caught that Claude's normal separator/footer lines sit below its empty
  composer. The final classifier accepts a styled dim suggestion plus normal
  footer while still rejecting a startup modal below a stale composer.
- Froze final source commit `d86a9cde915be5094d1d61ec0e9a8ca84b224f75`
  and binary SHA-256
  `1b71401da7507309cd4d3a70e59c07642e9c60d0a0935a93ebbb03d6f3dce14e`.
- The exact-prebuilt smoke passed without rebuilding or changing the candidate:
  delayed Claude readiness verified, never-ready launch exited 1 with a failed
  manifest and no session, the full detached layout was `220x60` with eight
  panes, and the missing-workspace case exited 1.
- Independent review returned `CONCUR` with no findings, bound to source commit
  `d86a9cde915be5094d1d61ec0e9a8ca84b224f75` and binary SHA-256
  `1b71401da7507309cd4d3a70e59c07642e9c60d0a0935a93ebbb03d6f3dce14e`.
- Harness preflight and stop-gate both passed with all six required dimensions:
  unit, focused, full, build, isolated-smoke, and independent-review.

## Why

Stable startup output is not proof that a TUI accepts input, and a detached
tmux server needs explicit geometry rather than the server default.

## Notes

Regression: yes
Regression id: loop102-claude-bootstrap-readiness
Regression symptom: Claude's startup confirmation swallowed the launch bootstrap.
Regression guard: tests/loop/tmux.test.ts plus evals/smoke/large-prompt-launch.sh

Regression: yes
Regression id: loop102-detached-tmux-geometry
Regression symptom: Detached paired launch started at 80x24.
Regression guard: tests/loop/tmux.test.ts plus evals/smoke/large-prompt-launch.sh

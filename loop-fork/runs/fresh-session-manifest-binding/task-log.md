# Task fresh-session-manifest-binding

Created: 2026-07-29T19:36:56Z
Mode: planned
Description: Persist deterministic tmux session identity before asynchronous paired-launch work

## What I changed

- Added a single manifest-binding helper for paired-session identity fields.
- Reused it for existing-session reattach and called it on fresh starts before
  hook generation, persistent-agent bootstrap, charter writes, or tmux pane
  creation.
- Added assertions at the first persistent bootstrap and first non-persistent
  tmux-create boundaries, plus failed-start retention coverage.

## Why

The tmux session name is deterministic before asynchronous launch work begins.
Persisting it only after the panes were built left active manifests temporarily
unassociated with their workspace, which made recovery and lifecycle tooling
blind during the riskiest startup interval.

## Notes

- The change adds no process cleanup and specifically does not infer tmux
  process identity from a retained `new-session` command line.
- Focused paired tmux tests: 57 pass, 0 fail.
- Full verifier: lint, defined source typecheck, compiled build, every sequential
  test, and empty baseline gate passed.
- Live run 100 remained read-only.
- Deployment remains held pending exact-SHA independent review.

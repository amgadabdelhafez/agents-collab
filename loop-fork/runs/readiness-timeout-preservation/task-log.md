# Task readiness-timeout-preservation

Created: 2026-07-31T08:06:25Z
Mode: planned
Description: Preserve paired tmux workspace and durable input-required evidence when Claude startup readiness times out, without reporting launch success or leaking ownership

## What I changed

- Traced the evidence loss to an untyped readiness-timeout error falling into
  generic failed-start teardown.
- Added a spec-first acceptance contract under
  `../specs/readiness-timeout-preservation/`.
- Added a narrow startup input-required error base shared by composer recovery
  and readiness poll exhaustion. Unexpected capture and tmux failures remain on
  the terminal failed-start path.
- Made the realistic-prompt smoke inspect `input-required/running`, both stable
  agent pane targets, absent control panes, absent work delivery, and the exact
  attach command before explicitly cleaning its isolated session.

## Why

The launcher must fail honestly without deleting the only live evidence and
manual recovery surface available to the operator.

## Notes

Regression: yes
Regression id: claude-startup-readiness-timeout-evidence-loss
Regression symptom: Claude readiness timeout exits nonzero but kills the paired tmux workspace and terminalizes the manifest as failed.
Regression guard: tests/loop/tmux.test.ts and ../evals/smoke/large-prompt-launch.sh

The active Harvto loop is outside this worktree and must not be restarted or
modified by this task.

Focused tmux result: 97 pass, 0 fail. Harness full result: 1,339 pass,
0 fail. Project verifier passed lint, typecheck, build, all tests, and the empty
baseline allowlist. The realistic 10KB-charter smoke passed with a nonzero
timeout, preserved evidence, explicit fixture cleanup, and unchanged
failed/failed behavior for a genuinely missing workspace.

One sandboxed verifier attempt reported every ephemeral loopback port as
`EADDRINUSE`; the focused websocket test and the complete verifier both passed
when rerun with localhost binding enabled. This was an execution-sandbox
artifact, not a baseline allowance.

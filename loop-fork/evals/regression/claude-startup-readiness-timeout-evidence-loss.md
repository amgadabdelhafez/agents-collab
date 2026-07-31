# Regression Eval: claude-startup-readiness-timeout-evidence-loss

Generated: 2026-07-31T08:32:53Z
Source task: `readiness-timeout-preservation`
Status: draft

## Failure Symptom

- Claude readiness timeout exits nonzero but kills the paired tmux workspace and terminalizes the manifest as failed.

## Guard Evidence

- tests/loop/tmux.test.ts and ../evals/smoke/large-prompt-launch.sh

## Verification Artifacts

- `smoke`: `runs/readiness-timeout-preservation/artifacts/smoke/verify.log` (pass)
- `unit`: `runs/readiness-timeout-preservation/artifacts/unit/verify.log` (pass)

## Source Task Notes

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

Independent review issued CONCUR with no findings on exact source/evidence
commit `6e197b461c53423309590b36fad746118ddeba34`. The exact compiled file
(`4e1b49970f17a4d6b5dd570b1d598a63a0e3c59b3334f4e782bad76917241b67`)
then passed the prebuilt realistic-prompt smoke and was atomically installed at
`/Users/amgad/.local/bin/loop`. Live Harvto run 105 retained all eight panes;
no restart or new launch occurred.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

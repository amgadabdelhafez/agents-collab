# Claude startup readiness timeout preservation task log

## Diagnosis

- A paired workspace was created and bound to its manifest before Claude
  readiness polling began.
- Poll exhaustion threw a plain `Error`, so `startPairedSession` treated it as
  an ordinary failed start, killed the tmux session, and rewrote the active
  manifest to `failed`.
- Existing composer-recovery errors already had the correct ownership model:
  release local persistent-transport ownership, retain the detached workspace,
  mark `input-required`, surface an attach command, and reject the launch.

## Implementation

- Added a narrow `ClaudeStartupInputRequiredError` boundary. Existing composer
  recovery and the bounded readiness timeout share this preservation path;
  arbitrary capture, tmux, and programming failures do not.
- The timeout remains nonzero and cannot reach bootstrap paste or normal
  `[loop] started tmux session` handoff logging.
- Stable left/right pane targets are attached at layout creation and persisted
  with `state: input-required`, `status: running`, and the exact tmux session.
- Updated the realistic-prompt fixture to keep both agent panes alive long
  enough to inspect the preserved evidence, then explicitly kill only its
  isolated fixture session.

## Verification

- Focused tmux suite: 97 pass, 0 fail.
- Full suite: 1,339 pass, 0 fail.
- Typecheck, compile, formatter/lint, and `git diff --check`: pass.
- Realistic 10KB-charter smoke: nonzero timeout; `input-required/running`;
  both agent panes preserved; no bootstrap, work, Governess, or recon panes;
  exact attach instruction recorded; fixture session explicitly removed.
- Negative boundary: an unexpected readiness capture exception still closes
  owned transport, kills the session, and terminalizes `failed/failed`.
- Missing-workspace smoke remains `failed/failed` with nonzero exit.

Durable command evidence lives under
`loop-fork/runs/readiness-timeout-preservation/artifacts/`.

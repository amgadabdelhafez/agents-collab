# D-015: Paired attach terminal capability failure

## Status

Queued for a fresh isolated governed operational-fix loop. Do not implement
this defect in the control-plane modernization worktree or an AI-CUR product
workspace.

## Confirmed failure

AI-CUR Run 17 launched successfully on installed harness v1.0.38 on
2026-08-09. The harness created `ai-cur-loop-17`, started Claude, Codex,
Governess, Nanny, Au Pair, and Recon, and persisted a running manifest. The
foreground launcher then exited nonzero with:

```text
open terminal failed: terminal does not support clear
[loop] error: Failed to attach to tmux session "ai-cur-loop-17".
```

The error described only the optional foreground attachment, not the launch.
Independent checks immediately afterward showed all six panes alive,
`sessionLiveness=live`, `sessionReady=true`, every Governess doctor check true,
and the worker already executing T12. A retry then correctly failed with a
workspace ownership conflict because Run 17 was healthy.

## Required behavior

- Detached paired-session creation and foreground attachment have distinct
  outcomes and error reporting.
- If the session is live and ready, an attach capability failure must not be
  reported as a launch failure.
- The command should exit success after printing the exact manual attach
  command, or fail before launch when foreground attachment is mandatory.
- Terminal capability detection must happen before any attach attempt and must
  not require changing the child agents' terminal environment.
- A retry hint must first state that the existing run owns the workspace and
  must never encourage a duplicate launch.
- Socket identity in the printed attach command must be explicit when the run
  uses a non-default tmux socket.

## Minimum regression evidence

- Launch a paired run using a terminal environment that cannot perform tmux
  clear/attach.
- Prove the detached session remains live and ready with every expected pane.
- Prove the launcher reports successful launch plus an attach-only warning and
  exits zero.
- Prove the printed manual command contains the exact socket and session.
- Prove a real session-creation failure still exits nonzero and is not relabeled
  as an attach warning.
- Prove an unrelated live lane remains untouched.

## Producer evidence

- Installed binary: `/Users/amgad/.local/bin/loop`, v1.0.38.
- Run manifest:
  `/Users/amgad/.loop/runs/ai-cur-458d3aca27ff/17/manifest.json`.
- Session: `ai-cur-loop-17`; manifest state `submitted`, status `running`.
- Governess doctor: `ok=true`, `sessionLiveness=live`, `sessionReady=true`,
  zero pending, expired, or dead-letter bridge messages.
- Live pane check: `%6` Claude, `%7` Codex, `%8` Governess, `%9` Au Pair,
  `%10` Nanny, `%11` Recon; every `pane_dead=0`.

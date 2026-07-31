# Spec: Claude Startup Readiness Timeout Preservation

## Problem

When a paired launch creates its tmux workspace but Claude never reaches a
verified input-ready prompt, the launcher currently exits nonzero and then
destroys the workspace. The manifest is terminalized as `failed`, so the pane
state that explains the timeout is lost and the operator has nothing to attach
to for recovery.

## Goal

Treat a bounded Claude startup-readiness timeout as an operator-recoverable
input state: preserve the exact paired tmux workspace and pane evidence, record
`input-required`, and still return a nonzero launch result.

## Requirements

1. A Claude startup-readiness timeout must preserve the live paired tmux
   session instead of invoking failed-start teardown.
2. The preserved manifest must use `state: input-required` and
   `status: running`, and must retain `tmuxSession`, `tmuxPaneLeft`, and
   `tmuxPaneRight` recovery targets.
3. The launcher must still fail nonzero and must not report launch success.
4. The error and log output must include the preserved session name and an
   exact `tmux attach -t <session>` recovery command.
5. No launch bootstrap may be loaded or pasted after readiness times out.
6. Locally owned persistent-agent transport handles must be released without
   closing the detached session that the preserved workspace references.
7. Fatal startup failures unrelated to Claude input readiness must retain the
   existing failed-state teardown behavior.
8. Unit and realistic-prompt smoke coverage must prove preservation. The smoke
   test must explicitly tear down its own preserved fixture session afterward
   so the test itself leaves no process or tmux leak.

## Non-goals

- Changing the startup readiness deadline, modal detection, or retry policy.
- Preserving arbitrary tmux or process-launch failures.
- Cleaning stale bridge sockets or unrelated historical sessions.
- Restarting or modifying the currently running Harvto loop.

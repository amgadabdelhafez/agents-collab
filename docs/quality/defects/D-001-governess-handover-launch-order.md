# D-001: Governess handover launches successor before predecessor retirement

Status: queued
Severity: P1
Subsystem: Governess handover and launch reservation
First confirmed: agents-collab Run 14, 2026-08-07

## User-visible failure

A handover can produce valid Claude, Codex, and combined manifest bundles and
cleanly exit both agent panes, but Governess then attempts to launch the
successor while the predecessor manifest still owns the same worktree and
branch. The launch reservation correctly rejects the replacement, leaving the
handover in `launch-error` and requiring a manual predecessor teardown plus
successor launch.

Observed rejection:

```text
[loop] launch conflict: run 14 (agents-collab-loop-14) still owns workspace /private/tmp/agents-collab-tmux-socket-normalization-run11 on refs/heads/codex/tmux-socket-normalization-run11; resume or stop that run before launching another
```

## Evidence

- Predecessor run: `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/14`
- Handover epoch: `1786161256726553`
- Valid bundles existed for Claude, Codex, and the combined handover manifest.
- Governess reached `exitControl.mode = "launch-error"` after the reservation
  rejected the replacement.
- The preserved worktree had no loss. After governed teardown, Run 15 launched
  on the same worktree and branch and persisted a
  `handover-manifest-acceptance` event at `2026-08-08T04:28:33.760Z`.

## Suspected mechanism

`advanceHandoverControl` writes the combined handover manifest and calls the
replacement launcher before the predecessor has transitioned to a terminal
manifest state and released its workspace claim. The reservation layer is
behaving correctly; the handover state transition order is not.

## Required behavior

1. Once both validated bundles exist and both agent panes have exited, perform
   an explicit predecessor-to-successor ownership transfer.
2. Release or atomically transfer the predecessor workspace reservation before
   the replacement claims the same worktree and branch.
3. Preserve the dirty worktree and handover bundles throughout the transfer.
4. If replacement startup fails, retain a durable recoverable state that can be
   retried without split-brain ownership or manual process archaeology.
5. Mark the handover complete only after the successor persists manifest
   acceptance and its required panes, bridge, Governess, and ports are healthy.

## Acceptance tests

- A producer-backed full Governess handover with valid Claude and Codex bundles
  launches a successor on the same worktree and branch without a reservation
  conflict.
- The predecessor is terminal and has no owned surviving processes after the
  successor becomes healthy.
- A forced successor-launch failure is retryable and preserves the exact dirty
  tree and bundle hashes.
- Concurrent unrelated runs remain unaffected.
- The regression checks persisted predecessor and successor manifests, exact
  workspace claims, pane/process ownership, bridge delivery, and cleanup rather
  than relying only on command exit status.

## Delivery lane

Implement in a fresh isolated governed loop after the current tmux socket
normalization release. Review stages are the governed loop's native review and
the harness engineer's independent zero-write exact-SHA review.

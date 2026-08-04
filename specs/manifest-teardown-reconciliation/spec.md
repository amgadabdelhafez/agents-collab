# Spec: Manifest Teardown Reconciliation

## Problem

A governed tmux workspace can terminate cleanly while its persisted run
manifest remains active. Loop 125 demonstrated the failure: the tmux session
and run-scoped processes were gone and the Codex proxy recorded `SIGTERM` and
`stopped`, but the manifest still declared `state: submitted` and
`status: running`. Discovery then reports a completed workspace as live.

## Requirements

1. The Codex tmux proxy must reconcile an active manifest to `stopped` when it
   has affirmative evidence that the manifest-bound tmux session is dead.
2. Reconciliation applies both to the proxy lifetime detector and to signal
   shutdown, because tmux teardown may signal the proxy before its next poll.
3. A live or unknown tmux result must preserve the manifest unchanged.
4. The atomic manifest update must re-check that the run is still active and
   bound to the same tmux session so a concurrent handoff or terminalization
   cannot be overwritten.
5. Reconciliation must be idempotent and must not claim completion; `stopped`
   is the truthful terminal state when intent is unavailable.

## Non-goals

- Inferring whether the task itself passed.
- Killing processes or tmux sessions.
- Rewriting historical stale manifests during this change.


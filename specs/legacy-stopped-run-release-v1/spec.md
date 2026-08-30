# Legacy stopped-run release command

## Problem

First-party legacy manifests can be truthfully terminal (`stopped`) while
lacking the modern `workspaceReleasedAt` proof required by launch reservation.
Operators currently have no bounded Loop command that can add that proof after
the recorded runtime is positively gone.

## Requirements

1. `loop reconcile stopped-run <run-id>` accepts exactly one canonical positive
   run ID and resolves only the current repository's normal Loop storage.
2. Reconciliation writes `workspaceReleasedAt` only when strict reservation
   evidence is valid, state and status are terminal/stopped, the same run and
   workspace identity remain bound, every recorded PID is dead or positively
   reused, and the exact branded tmux runtime is positively absent.
3. Unknown, live, malformed, rebound, or concurrently changed state refuses
   without changing manifest bytes or signaling any process.
4. Reconciliation is idempotent and emits one deterministic JSON result:
   `changed`, `already-released`, or `refused`. Invalid input and refusal exit
   nonzero.
5. Dispatch occurs before startup maintenance, update, reservation, task, and
   tmux-launch behavior.

## Non-goals

- Historical product-manifest inspection or mutation.
- Inferring completion, stopping processes, or killing tmux.
- Provider, dependency, UI, device, Harvto, Usage Tracker, or AI-CUR changes.

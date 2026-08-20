# D-011: Write-conflict holder diagnostics

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

In Harvto run 165, a driver truncated an Au Pair task ID, correctly received
`unknown task_id`, rerouted, then correctly received a write conflict because
the original task was still active. The response omitted the holding task ID,
age, and scopes, so the driver escalated a stale-reservation defect that did not
exist. Supervisor evidence message: `7bcdbed8-2b43-49e1-b2f9-58326ec595ab`.

## Required behavior

- Return the exact holding task ID, reservation age, lifecycle state, and
  declared overlapping scopes in every write-conflict response.
- Derive those fields from the reservation record, not caller-supplied text.
- Do not expose unrelated task payload or secrets.

## Regression evidence required

- Active-holder conflict includes exact task ID, bounded age, and only the
  overlapping scopes.
- Unknown, terminal, and orphaned holders produce distinct fail-closed results.

# D-008: Utility orphan lease reaping

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

In Harvto run 164, task `05:44:13 -> routed-utility 05:44:19 -> claimed
05:44:20 -> running 05:44:20` then produced no terminal event. A positive
process check at 05:52 found no utility worker for that task; the only live
worker belonged to another healthy task. The dead lease retained four write
reservations for more than eight minutes until supervised takeover. Supervisor
evidence message: `6e599b35-2f39-4d7c-ba28-023d81c118bd`.

Run 18 exposed the inverse failure at 2026-08-08T07:23:33Z: Codex escalated
task `60034e78-5c36-45eb-89e0-1634aff6d22f` for cancellation after a poll
budget even though exact worker PID `35923` was alive and the producer was
still appending successful tool events. The escalation was retracted. A poll
count alone is neither worker-death evidence nor cancellation authority.

Harvto runs 167 and 169 reproduced the same false-stall class during long
streaming edits. In run 169, task `5c7faced` was claimed at 14:35:53Z and its
task-level `updatedAt` remained frozen at claim time even while the exact
worker PID `63798` remained alive and `llm-trace`/tool-event records advanced
through at least 14:48:08Z. Two independent drivers escalated live work as
stuck because the task record exposed no advancing liveness timestamp.

## Required behavior

- Heartbeat every claimed task against its exact worker identity.
- On confirmed worker death, append a terminal `failed-orphaned` event and
  release only that task's reservations atomically.
- Never infer worker death from silence; use a positive process or ownership
  check and retain the evidence.
- A live worker with advancing producer evidence remains healthy regardless of
  poll count; do not escalate or cancel it merely because a client exhausted a
  polling budget.
- Refresh `updatedAt` on producer-trace progress or expose a durable
  `lastTraceAt`/equivalent field so task-status consumers can distinguish live
  streaming work from a stalled lease without reading private journals.
- Expose a documented driver cancellation request with durable accepted,
  rejected, and completed outcomes.

## Regression evidence required

- Producer-backed worker-death fixture reaches `failed-orphaned` and releases
  all owned reservations without affecting a concurrent healthy worker.
- Cancellation is idempotent and cannot release another task's scopes.
- Missing or ambiguous worker identity fails closed without releasing claims.
- Five or more client polls against a live advancing worker do not create a
  terminal transition or external escalation.
- A long-stream fixture advances the public liveness timestamp on trace
  progress while its state remains `running`; a poller using only the public
  task record does not classify it as stale.

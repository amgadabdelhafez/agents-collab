# Bridge Overflow Delivery

## Problem

The bridge bounds each target inbox at 32 pending messages. When that limit is
reached, the producer records the new message and a `dead-letter` resolution in
the durable ledger. `receive_messages` reads only pending messages, so a
pull-only receiver never sees the rejected message or its failure reason.

This failed in the standing Claude/Codex supervisor channel: high and urgent
review corrections were durable in `bridge.jsonl` but invisible to Claude's
normal receive path.

## Required behavior

1. The pending inbox remains bounded by its configured maximum.
2. Automatic delivery continues to ignore dead-lettered messages.
3. `receive_messages` returns each dead-lettered message addressed to the
   caller exactly once, including an explicit dead-letter status and reason.
4. A durable receipt records that the receiver observed the dead letter.
5. If one receive call reaches its output bound, later calls continue through
   the remaining unreported dead letters.
6. Queue status reports the number of dead letters not yet observed by their
   target.
7. Existing JSONL events and ordinary pending-message output remain compatible.

## Safety invariants

- Dead-letter visibility must not requeue work or make it eligible for automatic
  composer, tmux, or app-server delivery.
- Reading status must not acknowledge a dead letter.
- A malformed or receipt-only event must not manufacture a message.
- Delivery visibility is scoped to the addressed target.
- The durable bridge ledger remains the record of truth.

## Non-goals

- Increasing or removing the 32-message queue bound.
- Automatically retrying rejected work.
- Garbage-collecting historical bridge ledger events.
- Choosing a priority-eviction policy for a full queue.

# Governess Native Runtime

## Problem

Governess currently has durable control intent and epoch fencing, but the live
delivery path can still fall back to terminal typing and the journal does not
observe a real target acknowledgement. A dispatched control can therefore be
ambiguous after interruption, while repeated fallback typing can occupy the
same composer used by a user or peer agent. Lifecycle state is also partly
derived by the supervisor instead of being grounded in agent/runtime events.

## Required behavior

1. Every agent lifecycle transition is represented by a normalized event with
   agent, epoch, monotonic sequence, source, timestamp, and evidence reference.
2. Structured provider events are authoritative. Terminal inspection is a
   clearly marked fallback and cannot synthesize an acknowledgement.
3. Every effectful control has a stable idempotency key and progresses
   monotonically through durable phases. A dispatched or accepted control is
   reconciled, never blindly sent again.
4. Target evidence after dispatch acknowledges a control; terminal completion
   evidence completes it. Timeout produces a durable failure reason without
   duplicating text into the composer.
5. Handover is teardown-first: the old loop publishes bundles plus a manifest
   and continuation whose recorded hashes validate before old-loop teardown;
   the replacement then accepts that exact manifest.
6. Supervision logic exposes an immutable observation snapshot, pure decisions,
   and a transactional effect executor so recorded snapshots can be replayed.
7. Replay reports behavioral drift, and explain reports why a control existed,
   what policy allowed it, its transport, evidence, and phase history.
8. Dashboard height allocation remains stable for one or many judges and does
   not crowd duplicate agent information into extra rows.

## Safety invariants

- Never inject into a terminal unless the target is idle and its composer is
  empty immediately before delivery.
- Never repeat a dispatched control solely because an acknowledgement is late.
- Epoch and lease fencing precede all effects.
- Existing authorization policy remains the only action-authority boundary.
- Existing active Claude/Codex processes must survive a focused governess
  replacement.

## Compatibility

- Existing runs and journals remain readable.
- `babysitter` compatibility aliases remain accepted but user-facing output is
  governess-only.
- Single-agent modes and paired tmux resume semantics remain unchanged.

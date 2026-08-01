# Verify: Bridge Overflow Delivery

## Producer fixture

- The checked-in JSONL fixture is a deterministic redacted transform of the
  declared source slice; private message text, subject text, and signatures are
  not persisted.
- Its SHA-256, source-slice SHA-256, source-ledger SHA-256, installed producer
  binary SHA-256, transform, and producer commit binding are recorded.

## Behavioral checks

- A full target queue still contains exactly its configured number of pending
  messages after another message is dead-lettered.
- The addressed receiver sees the dead-lettered message and queue-limit reason.
- A second receive does not repeat the same dead letter.
- Two concurrent receive processes produce exactly one dead-letter result and
  exactly one durable `reported` event.
- A stale report claim is recovered, removed, and does not hide the message.
- Another target cannot observe it.
- More than one receive batch is drained without exceeding the per-call bound.
- Bridge status reports unreported dead letters before receive and zero after.
- Automatic delivery selectors never return the dead-lettered message.

## Release checks

```bash
bun test tests/loop/governess-p0-runtime.test.ts tests/loop/bridge.test.ts
bun run check
bun test
bun run build
../scripts/verify.sh
```

The run eval must pass before the branch is handed to the supervisor. This task
does not authorize installing or deploying the built binary.

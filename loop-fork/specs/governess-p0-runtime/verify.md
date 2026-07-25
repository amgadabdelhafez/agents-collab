# Verification

- Observation tests prove identical semantic state is suppressed until heartbeat
  and state changes are written immediately.
- Index tests prove missing/corrupt/stale sidecars rebuild from authoritative JSONL
  and interruption after dispatch preserves the idempotency fence.
- Compaction tests prove effectful histories and latest observations remain active,
  superseded observations are archived, and a simulated malformed tail fails closed.
- Bridge tests prove legacy compatibility, metadata round-trip, priority ordering,
  duplicate suppression, superseding, TTL expiry, bounded queues, dead letters,
  disconnected delivery, and backward clock behavior.
- Doctor tests prove storage/index/queue health and fault counts are visible.
- Run `bun test tests/loop/governess-p0-runtime.test.ts`, relevant existing tests,
  full `bun test`, `bun run check`, and `bun run build` through Harness.
- Inspect the live run read-only. Deploy only after all checks pass, preserving the
  Claude and Codex process IDs and replacing only the governess pane if necessary.

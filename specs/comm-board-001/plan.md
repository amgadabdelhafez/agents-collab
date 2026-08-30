# Plan: durable supervisor threads

1. Export one strict canonical board-item parser from the accepted read model.
2. Add an append-only JSONL thread store with exact event parsing and fsync.
3. Enforce event-id idempotency and immutable workflow/thread/category identity.
4. Materialize deterministic thread snapshots from authoritative journal events.
5. Test restart durability, replay/collision, lifecycle updates, corruption,
   immutable identity, ordering, redaction, and defensive outputs.
6. Run focused, one full, static/build/diff gates, freeze, and obtain independent
   zero-write exact-SHA review.

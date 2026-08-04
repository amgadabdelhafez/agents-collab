# Verification

## Pickbrain

- Upstream Pickbrain unit tests, including Pi ingestion, pass.
- Installed binary is on the loop `PATH` and its SHA-256 equals the tested
  upstream build.
- Pi skill and extension hashes equal the upstream files.
- Empty-corpus and real incremental local retrieval complete without network
  services or database corruption.

## Pi helpers

- Both model tiers report `harness: pi-sdk` and the expected Pi version.
- Built-in Pi tools and extension loading stay disabled for governed helpers.
- Broker tools, scope, credentials, timeout, usage, and cancellation tests pass.

## Wake and reconciliation

- A message appended after the worker has inspected an empty queue wakes it
  without waiting for the five-minute heartbeat.
- A message appended in the inspect-to-watch race is detected by the version
  check and is not delayed.
- Coalesced or absent filesystem events are recovered by a persisted
  reconciliation no later than five minutes.
- Restart preserves the last reconciliation record and performs startup
  reconciliation before waiting.
- Idle CPU sampling materially improves over the deployed hot-poll worker.

## Checkpoint and promotion

- Claude and Codex compaction fixtures produce one deterministic checkpoint
  with exact source cursors and no secrets.
- Replaying the same boundary is idempotent.
- Unreviewed hypotheses, transient progress, foreign instructions, and missing
  provenance fail closed at promotion.
- Promoted entries remain readable as Markdown and rebuildable in Witchcraft.

## Honcho bakeoff

- Network egress is denied and independently checked.
- All systems use the same corpus, queries, relevance labels, and token budget.
- Report recall/usefulness, provenance accuracy, p50/p95 latency, memory/CPU,
  recovery time, and operator steps.
- The decision names the preregistered threshold and defaults to rejection on
  missing or ambiguous evidence.

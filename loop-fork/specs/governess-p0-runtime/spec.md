# Governess P0 Runtime

## Problem

The native governess runtime is durable and fenced, but steady-state observations
still append two full records every tick and hot control lookups repeatedly scan
the entire JSONL journal. Bridge messages remain prose-only and have no expiry,
priority, deduplication key, queue bound, or dead-letter outcome. Recovery behavior
exists for individual paths but is not exercised as a coherent fault matrix.

## Required behavior

1. Unchanged observations are coalesced per observation stream and a bounded
   heartbeat remains available for liveness and replay.
2. Observation writes use one completed record. Effectful control phase history
   remains lossless and backward compatible.
3. Hot journal lookups use a validated durable sidecar index and rebuild it from
   JSONL when the sidecar is missing, stale, or corrupt.
4. Journal maintenance can archive superseded completed observations while
   retaining effectful controls, latest stream observations, and pending state.
5. Bridge messages support a typed work envelope with subject, priority, thread,
   reply, task, artifact, expiry, and deduplication metadata.
6. Bridge delivery orders higher priority first, expires stale messages, bounds
   outstanding work per target, supports superseding, and records dead letters.
7. Existing untyped bridge records and callers remain readable and functional.
8. Doctor output reports journal/index/storage and bridge queue/QoS health.
9. Deterministic tests cover interruption, duplication, stale fencing, malformed
   tails, disconnected delivery, expiry, backpressure, and clock changes.

## Safety invariants

- Effectful control history is never removed by journal maintenance.
- A missing or invalid idempotency index is rebuilt from the authoritative JSONL
  before an effect can be prepared.
- A dispatched control is reconciled and never resent after restart.
- Expired, superseded, duplicate, or dead-lettered bridge work is never delivered.
- Queue pressure never falls back to terminal composer injection.
- Malformed journal data fails closed and is never silently repaired.

## Compatibility

- Existing governess JSONL and bridge JSONL files remain valid inputs.
- Existing bridge callers default to a normal untyped-compatible message.
- Archives remain newline-delimited JSON and can be audited independently.

## Acceptance criteria

- [x] An unchanged observation stream writes at most one record per heartbeat.
- [x] Journal prepare/transition/pending lookups avoid repeated full-file scans.
- [x] Explicit compaction archives superseded observations atomically.
- [x] Typed bridge metadata round-trips through storage, inbox formatting, and MCP.
- [x] TTL, priority, dedupe, supersede, target queue limit, and dead letters have tests.
- [x] The recovery matrix passes and doctor exposes actionable storage/queue health.
- [x] Focused tests, full tests, check, build, and Harness stop-gate are recorded.

## Non-goals

- AS DELIVERED FOR P0: a web dashboard, full A2A server, distributed database, or multi-host consensus. The separately planned browser projection is governed by the root `specs/webui-control-plane/` package.
- Automatic repair of malformed durable control history.
- Container isolation or a multi-worktree merge refinery.

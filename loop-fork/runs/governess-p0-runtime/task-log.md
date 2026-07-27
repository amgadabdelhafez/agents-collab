# Task governess-p0-runtime

Created: 2026-07-25T22:45:19Z
Mode: planned
Description: Scale governess durability with journal coalescing and retention, typed bridge QoS, and deterministic recovery fault tests

## What I changed

- Created the spec, plan, tasks, verification contract, and research decision.
- Added a versioned journal sidecar index that rebuilds from authoritative JSONL,
  coalesces stable observations into one record per 60-second heartbeat, and
  archives superseded observations atomically above the retention threshold.
- Added typed bridge work envelopes with priority, TTL, thread/reply/task/artifact
  metadata, dedupe, supersede, per-target backpressure, and dead-letter outcomes.
- Added journal and bridge queue health to governess doctor/status output.
- Added deterministic recovery tests for mid-dispatch restart, corrupt indexes,
  malformed crash tails, duplicate hook evidence, disconnected delivery, expiry,
  backward clocks, backpressure, and superseding.

## Why

- The live loop showed that steady-state observations dominate journal growth,
  while the current bridge cannot express queue semantics safely.
- A one-hour/3,600-tick steady-state simulation produced 60 records, 28,931 bytes
  of JSONL, and a 715-byte hot index for one observation stream.

## Notes

Regression: yes
Regression id: governess-unbounded-observation-journal
Regression symptom: Unchanged runtime observations append two records every tick.
Regression guard: tests/loop/governess-p0-runtime.test.ts

## Verification

- Focused Harness unit proof: 91 tests passed.
- Full `bun test`: 612 passed; four unrelated Codex model/config expectation
  failures reproduced unchanged on the baseline branch.
- `bun run build`: passed.
- Targeted Ultracite check for changed P0 modules and tests: passed.
- Repository-wide `bun run check`: blocked by pre-existing formatting findings in
  historical `runs/` artifacts; the changed P0 files are clean.
- Live read-only check: `harvto-loop-34` agent PIDs remained Claude 10483 and
  Codex 10485; the old journal had reached 10,455,147 bytes / 2,996 records.

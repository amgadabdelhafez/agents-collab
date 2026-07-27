# Task utility-context-capsules

Created: 2026-07-27T18:06:45Z
Mode: planned
Description: Give governed utility workers bounded provider-neutral project context and replayable per-job task capsules

## What I changed

- Added a protected, provider-neutral `UTILITY.instructions.md` project brief.
- Built deterministic, bounded per-job context capsules from the root brief and
  explicitly selected repository references, with stable hashes and persisted
  replay artifacts.
- Passed capsule metadata through routing, bridge, runtime, usage evidence, and
  governess observability without expanding worker authority.
- Added one-shot `CONTEXT_INSUFFICIENT` escalation and runtime-owned pane
  summaries so provider output cannot echo hidden context into the worker pane.
- Added loader, path-boundary, routing, runtime, escalation, observability, and
  pane-leak regression tests.

## Why

Lower-cost workers needed enough consistent project context to accept more safe
utility work while remaining stateless, bounded, and owned by governess rather
than becoming peer agents with ambient repository authority.

## Notes

- Independent review passed after the pane-echo finding was fixed.
- The final focused Harness suite passed 277/277 tests. The full suite passed
  1032 tests with four unchanged Codex-config baseline failures reproduced on
  base commit `6e2ad81`.
- Commit `f132a90` was built and atomically installed for future loops. The
  candidate, canonical binary, and global command all have SHA-256
  `a7c88a635d36da549a2d8661792670f3ac0e56bbde18888f1c01f22d451a1a18`.
- No live loop was restarted or recreated.

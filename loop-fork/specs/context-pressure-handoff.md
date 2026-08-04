# context-pressure-handoff

Task completed 2026-08-04T19:47:18Z, mode planned.

## What was built

- Added model-specific context and assistant-turn profiles with deterministic
  context-first precedence and 75% preparation thresholds.
- Distinguished provider-labeled Claude automatic compactions from manual
  compactions; Codex records their missing trigger kind explicitly.
- Persisted per-agent pressure decisions and one-time preparation delivery.
- Connected due decisions to the existing two-phase handover controller only
  in enforce mode with tmux control available and no active exit lifecycle.
- Added observe/off/dry-run controls and transition-only telemetry.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-04T19:36:58Z)

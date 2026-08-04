# Task context-pressure-handoff

Created: 2026-08-04T19:36:58Z
Mode: planned
Description: Context-first session pressure and governed automatic handoff

## What I changed

- Added model-specific context and assistant-turn profiles with deterministic
  context-first precedence and 75% preparation thresholds.
- Distinguished provider-labeled Claude automatic compactions from manual
  compactions; Codex records their missing trigger kind explicitly.
- Persisted per-agent pressure decisions and one-time preparation delivery.
- Connected due decisions to the existing two-phase handover controller only
  in enforce mode with tmux control available and no active exit lifecycle.
- Added observe/off/dry-run controls and transition-only telemetry.

## Why

Session evidence shows similar context ceilings can occur at radically
different turn counts. Context pressure therefore leads, while model-specific
turns remain a secondary guardrail. Reusing the existing drain and bundle
controller protects in-flight atomic operations and avoids direct restarts.

## Notes

- Focused suites passed: session pressure 7, usage 22, Governess 76.
- `bun run check`, production build, targeted TypeScript check, and the full
  sequential `bun run test:ci` passed.
- Harness-certified unit verification, preflight, and stop-gate passed.
- No live loop was restarted or modified and no binary was deployed.

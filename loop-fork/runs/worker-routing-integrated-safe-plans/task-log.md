# Task worker-routing-integrated-safe-plans

Created: 2026-07-27T17:07:22Z
Mode: planned
Description: Integrate broader worker tools, four slots, runaway guards, structured read-only compound routing, and actionable skip telemetry

## Live evidence before implementation

- First 351 skipped observations: 189 tool-not-enforceable, 95 compound/unsafe,
  25 workspace-unverified, and 42 other bounded-policy reasons.
- Compound audit: 59 read-only chains, 20 mutation/remote-authority commands,
  13 dynamic interpreter/process commands, and 3 focused tests.
- Active governess executable inode differs from the installed executable; the
  in-memory classifier and newly spawned worker broker are on separate builds.

## Notes

Regression: yes
Regression id: integrated-worker-routing-contract
Regression symptom: Live classifier and spawned workers can expose different tool profiles, while safe compound reads remain with the primary agent.
Regression guard: tests/loop/delegation-policy.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-observability.test.ts

## What I changed

## Why

## Notes

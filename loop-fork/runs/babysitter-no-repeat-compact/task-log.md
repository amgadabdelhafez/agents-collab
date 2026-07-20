# Task babysitter-no-repeat-compact

Created: 2026-07-19T20:29:55Z
Mode: planned
Description: Stop limit restore flapping from sending repeated /compact messages into active loop agents

## What I changed

- Restore briefings are plain babysitter messages and never `/compact`.
- A future reset remains authoritative when one usage snapshot is missing.
- An unknown/past reset must remain absent for the configured cooldown.
- Restore delivery waits until its target is idle.
- Pressure on an agent that is not driving is deduped without a role message.
- Rebuilt and respawned only `harvto-loop-24:0.2`.

## Why

Loop-24 showed repeated `limit-restore` / `limit-handoff` pairs. A missing
usage snapshot falsely restored the already-active driver and injected a
context-destroying `/compact`; the still-future weekly limit reappeared on the
next read and armed the same cycle again.

## Notes

- Focused proof: 42 tests passed.
- Full proof: 562 tests passed; compiled executable built successfully.
- Broad `bun run check` remains red on existing repository-wide Ultracite
  findings, including unrelated source files and generated Harness JSON.
- Live proof after respawn: the babysitter PID changed to 67893, its persisted
  tick advanced, and no new `limit-restore` or `limit-handoff` record appeared.

Regression: yes
Regression id: babysitter-repeat-compact-on-limit-snapshot-flap
Regression symptom: Babysitter repeatedly injects `/compact` and interrupts the active loop agent.
Regression guard: tests/loop/babysitter.test.ts

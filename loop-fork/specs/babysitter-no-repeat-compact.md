# babysitter-no-repeat-compact

Task completed 2026-07-19T20:33:58Z, mode planned.

## What was built

- Restore briefings are plain babysitter messages and never `/compact`.
- A future reset remains authoritative when one usage snapshot is missing.
- An unknown/past reset must remain absent for the configured cooldown.
- Restore delivery waits until its target is idle.
- Pressure on an agent that is not driving is deduped without a role message.
- Rebuilt and respawned only `harvto-loop-24:0.2`.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-19T20:29:55Z)
- 002 - Live evidence: loop-24 emitted repeated limit-restore events and /compact commands whenever usage snapshots briefly omitted a still-future weekly limit (2026-07-19T20:29:56Z)
- 003 - Implemented stable limit restoration: no /compact command, future-reset hold, cooldown for missing snapshots, active-target gate, and non-driver dedupe (2026-07-19T20:32:17Z)
- 004 - Live loop-24 verification: babysitter PID 67893 is running the rebuilt binary; state ticks advance with no new restore/handoff log records after respawn (2026-07-19T20:33:48Z)

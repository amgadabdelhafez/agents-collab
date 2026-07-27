# bridge-turn-idle-freshness

Task completed 2026-07-27T01:50:39Z, mode planned.

## What was built

Rewrote `isClaudeTurnActive` (src/loop/bridge-runtime.ts) as a state ×
freshness decision table: a fresh `failed` tail (errored tool call mid-turn)
now counts as turn-active on the same 300s bound as `working`, and
`starting` goes idle after 30s so a resumed `--resume` session (no prompt,
journal stuck at SessionStart) no longer wedges Codex→Claude delivery
forever. Added `CLAUDE_TURN_STARTING_STALE_MS` / `CLAUDE_TURN_WORKING_STALE_MS`
and an injectable clock (`bridgeRuntimeCommandDeps.now`). TDD: ten new
tests in tests/loop/bridge.test.ts (turn-active matrix + three delivery
regressions) were written and watched fail first; the pre-existing
fresh-`working` regression is pinned to the mock clock. Spec bundle in
specs/bridge-turn-idle-freshness/.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-27T01:41:31Z)
- 002 - failed tail shares the working staleness bound (300s); starting gets 30s; clock injected via bridgeRuntimeCommandDeps.now (2026-07-27T01:49:44Z)

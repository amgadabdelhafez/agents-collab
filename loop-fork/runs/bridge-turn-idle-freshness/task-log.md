# Task bridge-turn-idle-freshness

Created: 2026-07-27T01:41:31Z
Mode: planned
Description: Fix isClaudeTurnActive: fresh failed tail counts as active; staleness bounds unblock resume/starting and stale working wedges

## What I changed

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

## Why

Live run 31 showed the bridge injecting into an active turn during the
window after an errored PostToolUse (journaled as state `failed`, read as
idle), and resumed paired runs blocked all automatic delivery because the
`starting` tail never ages out — a regression of the documented `--run-id`
resume flow.

## Notes

bun test tests/loop/bridge.test.ts: 85 pass / 0 fail. Full bun test:
816 pass / 4 fail — exactly the 4 known Codex-launch baseline failures.
`bun run check` and `tsc --noEmit` deltas vs. baseline: zero (196 lint /
359 tsc lines pre-existing both before and after). hooks/emit.ts lifecycle
mapping intentionally unchanged.

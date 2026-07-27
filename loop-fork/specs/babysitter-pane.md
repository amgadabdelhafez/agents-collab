# babysitter-pane

Task completed 2026-07-04T16:30:19Z, mode planned.

## What was built

Added an opt-in `--babysit` third tmux pane to loop-fork's paired mode:
- T-01 `--babysit*` CLI flags, `BabysitterVerdict` + contract types, `babysit`/
  `tmuxPaneBabysit` manifest fields (`args.ts`, `types.ts`, `constants.ts`, `run-state.ts`).
- T-02 normalized hook emitter + Claude `--settings` / Codex `hooks.json` generators +
  `__hook-emit` subcommand (`hooks/emit.ts`, `hooks/settings.ts`, `cli.ts`).
- T-03 deterministic stuck-detector, T-04 Qwen verdict client, T-05 gated recovery
  ladder — built in parallel worktrees, merged, and deduped to shared `types.ts`.
- T-06 `babysitTick` control loop + `__babysit` subcommand + status board + `babysitter.jsonl`.
- T-07 full-width bottom pane (`split-window -v -f`) and launch-time hook injection in
  `startPairedSession` (Claude always; Codex only with a per-run CODEX_HOME).
- T-08 verification + touched-file lint/tsc cleanup.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-04T15:36:35Z)
- 002 - T-01 done: babysit flags/types/manifest; discovered pre-existing baseline lint(16)/tsc/tmux-test(5) debt from biome+bun-types drift (2026-07-04T15:44:29Z)

# Task babysitter-pane

Created: 2026-07-04T15:36:35Z
Mode: planned
Description: Add opt-in --babysit third tmux pane: hook injection for both agents, deterministic stuck detector, local-Qwen verdict, gated auto-recovery ladder

## What I changed

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

## Why

`loop --tmux` gives no in-session view of progress and no recovery when an agent silently
stalls. The babysitter summarizes both agents from real hook events and auto-recovers a
stuck one, with a deterministic trigger (LLM never triggers action) and gated ladder.

## Notes

46 new tests, all green; tsc + biome clean on every new/touched file; `loop` binary builds.
The 5 failing `runInTmux` tests are a pre-existing vendoring artifact (loop-fork nested in
agents-collab makes `resolveRunBase` yield `agents-collab` vs the tests' hardcoded
`loop-fork`); they pass in the standalone upstream, so left untouched. Local Qwen backend =
Qwen3.6-35B-A3B on `:8082`.


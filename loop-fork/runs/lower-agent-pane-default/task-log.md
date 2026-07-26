# Task lower-agent-pane-default

Created: 2026-07-26T03:23:05Z
Mode: planned
Description: Show a compact top-right utility observer by default and persist pane targets

## What I changed

- Added a default top-right utility observer to paired tmux startup, sized to
  eight visible rows after the governess split.
- Persisted left, right, utility, and governess pane targets in the run
  manifest; bridge delivery and governess observation consume those targets.
- Expanded the read-only pane with readiness, queue counts, current objective,
  latest bounded tool, and latest token/cost status.
- Documented `LOOP_UTILITY_PANE=0` as the explicit three-pane opt-out and added
  `LOOP_UTILITY_PANE_HEIGHT`.

## Why

The lower agent should be visible by default without making pane indices part
of the routing protocol. Persisted targets keep the control plane correct when
the observer inserts a pane above the right main agent.

## Notes

- Focused Harness verification: 189 pass, 0 fail.
- `bun run build`: pass.
- Full suite: 677 pass; four pre-existing Codex-default expectation failures
  remain in `paired-options.test.ts` and `runner.test.ts`.
- Live 160x44 tmux proof: left main `0.0`; utility `0.1` at top-right with
  height 8; right main `0.2`; full-width governess `0.3`.
- Live opt-out proof: two full-height main panes above the full-width governess.

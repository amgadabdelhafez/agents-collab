# Task log: tmux redraw backpressure

## Live incident evidence

- Run: `harvto-loop-101`
- tmux server PID: `4482`
- Observed CPU: `98.7-100%`
- Sample stack: `server_client_loop -> screen_redraw_screen -> tty_draw_line`
- Control symptom: every bounded tmux probe stalled for two seconds
- Governess symptom: repeated `tmux-control-unavailable`, about 22.5 seconds
  between board refresh opportunities
- Mitigation: killed only attached client PID `18476`; server and panes were
  excluded, server CPU returned to about `0.2%`, session survived
- Separate state: Codex pane `%1` was already dead after app-server WebSocket
  reset; no automatic respawn performed

## Implementation log

- Spec, plan, tasks, and verification contract created before implementation.
- Replaced full-screen clears after the first frame with line-delta terminal
  updates, so unchanged board rows are not repainted.
- Moved agent pane capture ahead of pane-dependent decisions. The first timeout
  stops the tick's remaining tmux observations, renders an explicit degraded
  state from durable evidence, and suppresses recovery, roles, lifecycle
  transitions, renames, waiting inference, and handover progress.
- Replaced per-agent current-command probes with one batched `list-panes` read.
- Removed redundant per-cycle Governess title writes; startup remains
  self-healing and agent border titles remain change-deduplicated.
- Focused Governess/tmux/lifecycle verification: 92 pass, 0 fail.
- Lint, source typecheck, and compiled build pass.
- First full-suite run had one unrelated five-second timeout in
  `tests/loop/pi-runtime.test.ts`; the same file immediately passed 4/4 alone.
- A clean sequential rerun of the complete `bun run test:ci` suite passed.
- Private real-tmux smoke with a forced two-second control outage passed:
  degraded state rendered at tick 2 and cleared at tick 3 after recovery.

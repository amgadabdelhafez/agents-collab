# Spec: tmux redraw backpressure

## Problem

In live run `harvto-loop-101`, the tmux server entered a redraw storm while a
terminal client was attached. The server consumed one CPU core in
`screen_redraw_screen -> tty_draw_line`, and all tmux control commands stalled.
Governess performs synchronous pane captures before rendering, so one unavailable
pane caused the whole board tick to abort. Its refresh interval stretched to
roughly 22.5 seconds and the pane appeared frozen even though persisted state and
the Governess process were healthy.

The current two-second tmux command timeout bounds one command, but it does not
bound a complete tick: pane observations are sequential, retry every cycle, and
the exception path skips rendering. A slow or wedged tmux server can therefore
multiply latency and hide its own degraded state.

## Goal

Keep the Governess board responsive from last-known durable evidence when tmux
control is unavailable, while refusing every pane-dependent control action until
fresh pane evidence returns. Prevent repeated pane probes from multiplying a
single tmux outage across the same tick.

## Requirements

1. Treat tmux control availability as a per-tick dependency with one bounded
   failure budget. After the first unavailable control command in a tick, do not
   issue additional pane captures or pane mutations in that tick.
2. Preserve last-known observations for display only and render a compact,
   explicit `tmux degraded` marker with the failure age/reason.
3. Never recover, nudge, deliver, change driver roles, or infer liveness from
   stale pane evidence. Pane-dependent control actions fail closed until a fresh
   capture succeeds.
4. A tmux-control failure must not abort the whole Governess cycle. Durable run,
   bridge, utility, usage, cost, and journal evidence continues to refresh and a
   board frame is rendered when output itself remains writable.
5. When tmux control recovers, the next successful probe clears the degraded
   state, refreshes pane observations, and resumes ordinary safe control.
6. Preserve the existing two-second per-command hard timeout and do not create
   background tmux command accumulation.
7. Do not change the pane layout, pane dimensions, history limit, worker routing,
   agent prompts, or model configuration in this slice.
8. Do not automatically kill attached clients or respawn Claude/Codex. Live
   process recovery remains an explicit supervisor action.
9. Add realistic regression coverage using large, Unicode-rich pane output and a
   stalled-control simulation; board refresh behavior must not depend on prompt,
   pane-history, or rendered-frame byte size.

## Non-goals

- Patching tmux itself or claiming the harness caused the upstream redraw loop.
- Recovering the already-dead Codex app-server session in run 101.
- Automatically detaching a user's terminal client.
- Replacing tmux with a different terminal multiplexer.

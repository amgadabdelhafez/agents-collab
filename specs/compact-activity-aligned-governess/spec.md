# Compact activity pane and aligned Governess board

## Problem

The governed tmux layout spends three bottom panes on Routes, Tools, and Results. The Governess board aligns its outer columns, but composite values such as tokens, activity, effort/mode, context, limits/reset, and cost/rate drift internally because they are rendered as variable-width strings.

## Requirements

- New governed sessions create one bottom `activity` pane, not three recon panes.
- The activity pane contains recent routes, tools, and results in one bounded viewport.
- `LOOP_RECON_PANES=0` remains an opt-out; other enabled values normalize to one pane.
- Legacy direct `__recon-pane` indices 2 and 3 remain readable for compatibility.
- Governess composite headers and values use identical fixed subcolumn boundaries for main agents and helpers.
- Preserve semantic quota order and align weekly values across Claude and Codex.
- Do not mutate the currently running loop.

## Acceptance

- Tmux tests prove one activity split and no second or third recon split.
- Recon tests prove index 1 includes route, tool, and result evidence.
- Governess tests compare header and value character positions for token and activity subcolumns across main and helper rows.
- Focused tests, full certified tests, lint, build, and diff checks pass.

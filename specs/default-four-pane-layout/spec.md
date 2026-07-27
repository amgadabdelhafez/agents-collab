# Default four-pane loop layout

## Goal

Every new governed paired loop should reproduce loop 47's current pane
geometry without manual resizing.

## Required layout

- Top region: 60% of the window, split approximately 50/50 between the two
  main agents.
- Bottom region: 40% of the window.
- Bottom-left: governess at 75% of the bottom-region width.
- Bottom-right: output-only worker at 25% of the bottom-region width.
- Preserve the existing pane titles and manifest identities.
- `LOOP_UTILITY_PANE=0` continues to omit the worker, leaving governess full
  width.
- `LOOP_UTILITY_PANE_WIDTH` may override the worker width; accept the old
  `LOOP_UTILITY_PANE_HEIGHT` variable as a deprecated compatibility alias.

## Acceptance

- A new governed paired loop creates main agents first, then a full-width
  bottom governess, then splits the worker to the governess's right.
- Defaults use `--governess-height 40%` and worker width `25%`.
- The manifest records the actual stable pane IDs after both control panes are
  created.
- Focused tmux tests, full tests, build, and diff check pass.

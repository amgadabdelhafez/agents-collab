# Task recon-pane-labels

Created: 2026-07-28T02:23:48Z
Mode: emergent
Description: Rename recon pane borders to routes, tools, and results

## What I changed

- Renamed recon pane borders to `routes.<session>`, `tools.<session>`, and
  `results.<session>`.
- Preserved the three read-only views, pane IDs, layout order, and refresh
  behavior.

## Why

Semantic labels make each read-only dashboard understandable without requiring
the user to remember what recon1, recon2, and recon3 mean.

## Notes

Regression: yes
Regression id: semantic-recon-pane-labels
Regression symptom: Recon pane numbers did not explain their contents.
Regression guard: tests/loop/tmux.test.ts

## Verification

- `bun test tests/loop/tmux.test.ts tests/loop/recon-pane.test.ts`: 53 pass,
  0 fail.
- `bun run build`: passed.
- Harness preflight and stop gate: passed.
- Live Loop 57 borders read `routes`, `tools`, and `results` in the existing
  bottom-row order.
- Claude PID `70452` and Codex PID `70454` were preserved.

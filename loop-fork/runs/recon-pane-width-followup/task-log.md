# Task recon-pane-width-followup

Created: 2026-07-28T02:48:57Z
Mode: emergent
Description: Give routes more width and shrink tools further

## What I changed

- Shifted another 15 live columns from tools to routes.
- Changed the future three-pane split to approximately 51% routes, 15% tools,
  and 34% results.

## Why

The compact tools summary remains readable at 35 columns while route
objectives benefit directly from the additional horizontal space.

## Notes

Regression: yes
Regression id: recon-pane-width-followup
Regression symptom: The tools pane still consumed space needed by route
objectives after its rows were compacted.
Regression guard: tests/loop/tmux.test.ts

## Verification

- Focused suite: 53 pass, 0 fail.
- Build, Harness preflight, and Harness stop gate: passed.
- Live widths: routes 120, tools 35, results 78.
- All eight Loop 57 pane IDs and PIDs were preserved.

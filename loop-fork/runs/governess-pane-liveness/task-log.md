# Task governess-pane-liveness

Created: 2026-07-29T20:18:16Z
Mode: planned
Description: Make dead Governess panes visible and recover exact active ownership within a durable restart budget

## What I changed

- Added a hidden pane-death helper with exact active manifest/session/pane
  validation, immediate revalidation, and a durable rolling restart budget.
- Armed each fresh Governess pane with a pane-scoped `pane-died` hook and
  explicit stopped-pane border/body formatting.
- Persisted the stable Governess pane target before arming the hook.
- Added 23 helper tests plus CLI and paired-tmux integration assertions.

## Why

`remain-on-exit` retained a dead Governess frame that looked live indefinitely.
Bounded recovery restores an isolated failure while stopped-pane rendering and
the three-attempt limit keep terminal and crash-loop states honest.

## Notes

- Focused band: 99 pass, 0 fail.
- Full sequential verifier: pass with an empty baseline allowlist.
- Isolated tmux proof: active recovery passed; stopped-run suppression passed.
- Immediate reconciliation proof: a live pane stayed live without a journal;
  crashes 1-3 recovered and crash 4 stopped under the rolling budget.
- Hook arming occurs after all control panes and the stable manifest are
  durable, avoiding startup-failure teardown races.
- Harvto run 100 remained read-only and live.
- Exact commit `0292b673bdac946317af875189d14ac69fdf6c4c` received independent
  CONCUR and its binary was deployed with SHA-256
  `cda5d9ccf69ac611bf6125f9aacb42ad1fd203a1548bc271393a1cdafa33afca`.
- The deployed source passed the private real-tmux constant-size transport
  smoke before loop-65 QA was countersigned.

# Task log

- 2026-07-29T20:18:16Z — Specified the frozen-dead-pane failure and activated
  an isolated planned task without mutating Harvto run 100.
- 2026-07-29T20:27:00Z — Added exact manifest/session/pane ownership checks,
  two-phase revalidation, a three-attempt/five-minute durable budget, pane-local
  `pane-died` hook wiring, and explicit stopped-pane formatting.
- 2026-07-29T20:31:00Z — Focused CLI, tmux, and liveness coverage passed: 99
  tests, 0 failures. Formatting and isolated source typecheck passed.
- 2026-07-29T20:33:00Z — Isolated tmux proof recovered an active dead `%0`
  pane with the same identity and two journal rows. After changing that proof
  manifest to `stopped`, the next exit remained dead, rendered `STOPPED`, and
  added no attempt. The isolated server/files were removed; Harvto run 100
  remained live.
- 2026-07-29T20:35:47Z — Full verifier passed lint, defined source typecheck,
  compiled build, and every sequential test, then correctly stopped at the
  missing root eval gate. This eval now records the evidence; release remains
  held for exact-SHA independent review.
- 2026-07-29T20:36:54Z — Full verifier rerun passed end to end with an empty
  named baseline allowlist. Candidate remains undeployed pending exact-SHA
  independent review.
- 2026-07-29T20:42:18Z — Closed the split-to-hook early-exit race by running
  the newly armed pane hook once. A second isolated tmux proof confirmed the
  immediate live-pane run is a no-op, exits 1-3 recover with stable pane
  identity, exit 4 is suppressed by the rolling budget and remains visibly
  `STOPPED`, and the journal contains exactly three attempts plus suppression.
  Full verification passed again; the earlier review request was withdrawn.
- 2026-07-29T20:49:00Z — Moved hook arming after complete control-pane creation
  and final stable-manifest persistence. `split-window -k` retains any earlier
  Governess exit for the immediate reconciliation, while a later helper-pane
  startup failure now tears down before any liveness hook exists. Focused and
  full verification passed after the ordering change; the superseded review
  request was withdrawn.

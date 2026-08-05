# Spec: Governess handover composer readiness

## Problem

During the confirmed loop-131 `x`, then `h` succession, both handover controls
remained in `prepared` with `notified:false`. Codex was stopped at its normal
dim idle suggestion, but Governess used an unstyled tmux capture and treated
that suggestion as a foreign draft. The handover therefore could not begin.

Claude simultaneously showed a dim ghost suggestion. Neither pane's ghost
suggestion may block delivery. A real, non-dim draft must continue to block.

## Requirements

1. Handover readiness uses a styled tmux capture when available.
2. Text rendered entirely in SGR dim styling is ghost suggestion text and does
   not make the composer non-empty.
3. Non-dim composer text remains a foreign draft and blocks handover delivery.
4. Missing styled-capture support falls back to the prior fail-closed behavior.
5. The fix changes no handover authority, exit ordering, or replacement-loop
   teardown rule.

## Acceptance

- Producer-shaped Codex idle suggestion capture reaches exactly one handover
  delivery.
- The same capture with non-dim text reaches zero deliveries.
- Focused Governess exit tests, the Governess suite, full tests, build, and
  repository verification are recorded before review.

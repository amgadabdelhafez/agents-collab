# D-002: Governess handover loses pending peer actions

Status: queued
Severity: P1
Subsystem: Governess handover and bridge delivery
First confirmed: agents-collab Run 14 to Run 15, 2026-08-07

Latest recurrence: agents-collab Run 19 to Run 20, 2026-08-08

## User-visible failure

The successor accepted the validated handover manifest and both launch charters
named the outstanding native review as the first continuation action. However,
the predecessor's pending review request was not present in the successor
reviewer's bridge inbox. The reviewer had to reconstruct that the request must
be re-sent from prose in the handover bundles.

Lost action:

```text
d89784cd-7189-4bf7-9755-d61c21096bfc
```

The original request was queued in Run 14. Run 15's Claude reviewer reported
that its inbox contained only a utility result and no review request.

The defect recurred after Run 19 completed both validated handover bundles and
Claude independently PASSed the risk-C slice. Run 20 started with healthy panes,
the correct worktree, and the preserved 10-modified plus 4-untracked tree, but
its bridge journal was absent and the Codex driver stopped at `Ready for first
task.` The Run 19 bundle's required next action, F2 A1-A3 plus the nine
session-liveness caller migrations, was not mechanically submitted. Harness
engineering had to inject and submit that continuation manually before Run 20
started work.

## Required behavior

Every actionable item pending at handover must have one mechanically verifiable
successor outcome:

1. transferred with a new successor-run message ID linked to the predecessor
   message ID;
2. explicitly re-issued by the new driver and acknowledged by the intended
   recipient; or
3. durably marked failed with an exact reason and surfaced as a blocking
   successor startup action.

Prose in a continuation bundle is supporting context, not delivery proof.

## Acceptance tests

- A producer-backed handover with one pending review request and one pending
  work request produces linked successor messages and recipient acknowledgments.
- The successor cannot report handover ready while an actionable predecessor
  item is neither transferred, re-issued, nor durably failed.
- Duplicate replay is idempotent and preserves predecessor-to-successor lineage.
- A recipient that is unavailable yields a durable exact failure within 60
  seconds; the action does not silently disappear.
- The regression verifies bridge journals and recipient inbox state, not just
  bundle prose or launch success.

## Delivery lane

Implement in a fresh isolated governed loop after the current tmux socket
normalization release. Keep this separate from D-001 because reservation
ownership transfer and bridge action continuity have different producers and
failure recovery paths.

# D-006: Governess summary delivery freshness

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

Run 17 displayed this `Next` narrative after the successor was already active:

> Claude must call receive_messages to consume the pending bridge message,
> which likely contains the scope decision or handoff bundle from the previous
> run.

The durable bridge ledger showed the pending message was a current-run
Governess preparation decision, not an unknown previous-run scope bundle. At
2026-08-08T07:01:28Z Claude called `receive_messages`; the ledger then marked
both the Governess decision `eb24dc07-3057-4a13-abe0-47318d9edcc3` and Codex
handover `01a839c3-5879-400d-99e9-1268f5d493b0` delivered. Claude immediately
began processing them, but the live panel continued to show the same stale
`Progress` and `Next` text.

This is separate from message delivery. Delivery succeeded after the standard
ghost-typeahead probe and bridge nudge; the summary renderer failed to reconcile
its narrative with the new durable state.

## Required behavior

- Derive pending-message claims from the durable bridge ledger. Do not use
  speculative language such as `likely contains` when type, source, subject,
  and delivery state are known.
- Within one Governess summary tick after a message becomes delivered, remove
  any instruction to receive that message.
- Recompute `Objective`, `Progress`, and `Next` from the same current snapshot
  so they cannot contradict one another or the agent lifecycle row.
- Treat a successfully delivered message plus subsequent agent tool activity as
  positive evidence that the prior receive action is complete.
- If summary generation cannot obtain a consistent snapshot, show an explicit
  unavailable/stale marker rather than a fabricated next action.

## Regression evidence required

- Producer-backed fixture with one pending message, then a durable delivered
  event and subsequent agent activity.
- Assert the pre-delivery summary asks for receipt and identifies the exact
  known message class without speculation.
- Assert the first post-delivery summary no longer asks for receipt and reflects
  the new activity.
- Assert delayed or out-of-order observations cannot resurrect the old action.
- Live pane proof that the panel refreshes after a real bridge delivery.

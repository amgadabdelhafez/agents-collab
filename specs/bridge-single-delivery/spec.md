# Bridge single-delivery ownership

## Problem

Loop 48 displayed the same worker escalation three times in Claude even though
`bridge.jsonl` contained one message record. Automatic tmux delivery held an
advisory claim while Claude could concurrently call `receive_messages`, so both
paths could consume the same pending item. The tmux readiness check also treated
Claude's empty composer during an active turn as idle and injected into its
queued-input area.

## Requirements

- A bridge message owned by an active automatic-delivery claim must not be
  returned by `receive_messages`.
- Automatic tmux delivery to Claude must wait while the latest Claude hook says
  the agent is starting or working, even when the composer appears empty.
- Once Claude is idle, automatic delivery retains the existing submission
  confirmation and stranded-composer retry behavior.
- Delivery remains fail-closed: an unconfirmed message stays pending and can be
  polled after the automatic claim is released.
- Do not restart or alter either main agent pane during deployment.

## Acceptance

- A regression proves a claimed message is invisible to polling.
- A regression proves an active Claude turn cannot receive tmux injection.
- Existing bridge delivery, retry, queue, and deduplication tests pass.
- The live repeating loop-48 ID is resolved once and does not recur.

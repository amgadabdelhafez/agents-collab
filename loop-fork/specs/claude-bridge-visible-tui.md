# claude-bridge-visible-tui

Task completed 2026-07-26T04:46:34Z, mode planned.

## What was built

- Routed inbound Claude messages through its visible tmux pane whenever Claude
  is a member of a live paired session.
- Kept MCP channel notifications for headless/non-member Claude delivery.
- Kept Claude/non-Codex worker draining active while the Codex tmux proxy owns
  Codex delivery.
- Added a Claude composer guard so a non-empty user draft is never overwritten.
- Prevented explicit non-Claude pair routing from falling back to pane 0.0.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-26T04:27:28Z)
- 002 - Confirmed false delivery after Claude session transition; use visible tmux delivery for live runs and retain channels only for headless runs (2026-07-26T04:27:28Z)
- 003 - Focused bridge suite passes 55/55; full suite has four unrelated Codex config expectation failures and build passes (2026-07-26T04:40:39Z)
- 004 - Live run 38 end-to-end canary passed in both visible panes; final binary and worker deployed (2026-07-26T04:46:25Z)

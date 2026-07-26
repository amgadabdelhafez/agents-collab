# Task claude-bridge-visible-tui

Created: 2026-07-26T04:27:28Z
Mode: planned
Description: Deliver Claude bridge messages visibly and reliably through its live tmux pane

## What I changed

- Routed inbound Claude messages through its visible tmux pane whenever Claude
  is a member of a live paired session.
- Kept MCP channel notifications for headless/non-member Claude delivery.
- Kept Claude/non-Codex worker draining active while the Codex tmux proxy owns
  Codex delivery.
- Added a Claude composer guard so a non-empty user draft is never overwritten.
- Prevented explicit non-Claude pair routing from falling back to pane 0.0.

## Why

Run 38 showed 31 unique inbound messages after 03:11 marked delivered even
though Claude never saw them. The channel path acknowledged a stdio write with
no provider receipt, and the stream detached from the active conversation after
a session transition.

## Notes

Regression: yes
Regression id: claude-channel-false-delivery-after-session-transition
Regression symptom: Claude misses bridge rulings while the ledger reports delivery.
Regression guard: tests/loop/bridge.test.ts

- Focused bridge suite: 56 pass, 0 fail.
- Full suite: 613 pass, 4 unrelated Codex config expectation failures.
- Build and `git diff --check`: pass.
- `bun run check`: unavailable because `ultracite` is not installed.
- Live request `6054874c-2365-4a03-8572-8c74e4952a82` was visibly submitted
  to Claude and acknowledged once as `sent to claude tmux pane`.
- Claude returned `LIVE-CLAUDE-VISIBLE-CANARY-RUN38-OK` as message
  `bfcd8df0-7a04-439e-8e8a-40335825d6cf`; Codex visibly received it and the
  ledger acknowledged it as `submitted through visible codex tmux pane`.
- Claude and Codex pending counts were both zero after the canary.

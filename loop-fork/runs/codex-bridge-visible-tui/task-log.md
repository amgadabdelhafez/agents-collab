# Task codex-bridge-visible-tui

Created: 2026-07-26T03:41:52Z
Mode: planned
Description: Deliver idle Codex bridge requests through the visible TUI instead of headless app-server turns

## What I changed

- Split guarded tmux submission from acknowledgement in `bridge-runtime.ts`.
- Routed every incoming Codex bridge request through the visible pane.
- Removed proxy-originated bridge `turn/start`, `turn/steer`, active-turn
  recovery, and response-consumption state.
- Added acknowledgement, failure, reconnect, and no-headless-fallback tests.

## Why

The proxy could previously start a turn that app-server processed while the
Codex TUI remained idle. A later pane nudge then recovered the already-delivered
request from the ledger and duplicated the work. Making the TUI the only bridge
submission surface keeps the request and resulting activity visible.

## Notes

- Focused verification: 61 tests passed across proxy, CLI integration, and
  bridge suites.
- Ultracite check passed for all touched TypeScript files.
- `bun run build` compiled the standalone `loop` binary successfully.
- Focused verification expanded to 111 passing tests across proxy, bridge, and
  tmux suites after adding current-TUI readiness detection.
- The full serial suite has one confirmed unrelated baseline failure in both
  checkouts: `paired-options.test.ts` expects `gpt-5.5`, while the repository
  default and current config are `gpt-5.6-sol`.
- Installed the compiled binary as the global `loop` default.
- Live run 38 canary `e9f6b36d-6b05-44a0-9884-5a43dbe92aa9` appeared as a
  `Claude:` request in the Codex TUI, was acknowledged with reason `submitted
  through visible codex tmux pane`, and produced bridge reply
  `VISIBLE-BRIDGE-CANARY-OK` without project file access.

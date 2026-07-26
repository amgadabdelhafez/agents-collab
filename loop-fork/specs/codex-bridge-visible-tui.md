# codex-bridge-visible-tui

Task completed 2026-07-26T04:04:04Z, mode planned.

## What was built

- Split guarded tmux submission from acknowledgement in `bridge-runtime.ts`.
- Routed every incoming Codex bridge request through the visible pane.
- Removed proxy-originated bridge `turn/start`, `turn/steer`, active-turn
  recovery, and response-consumption state.
- Added acknowledgement, failure, reconnect, and no-headless-fallback tests.

## Decisions made

Every incoming Codex bridge request is submitted through the visible TUI. The
proxy no longer originates app-server turns or steers for bridge delivery.

## Open items at completion

No commit or push was requested. The serial suite retains the unrelated stale
`gpt-5.5` expectation in `paired-options.test.ts`.

## Trajectory

- 001 - initial (2026-07-26T03:41:52Z)
- 002 - live-visible-canary (2026-07-26T04:03:16Z)

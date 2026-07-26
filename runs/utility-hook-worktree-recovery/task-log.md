# Task log

- 2026-07-26: Confirmed loop 47 worker healthy and idle with no requests since
  22:38Z. Manifest root is `/Users/amgad/harvto`, while Claude works in the
  registered `/private/tmp/harvto-loop47-base` worktree.
- 2026-07-26: Confirmed automatic hook classification rejects before job
  creation and currently does not journal the rejection. Codex explicit routing
  is independently unavailable because its MCP transport is closed.
- 2026-07-26: Implemented verified hook-cwd adoption, absolute adopted scopes,
  early rejection telemetry, and exact skip-reason aggregation.
- 2026-07-26: Added proxy recovery after an exact loop-bridge `transport
  closed` failure. Recovery has an exact server match and a five-second
  in-flight timeout; the internal reload response is not forwarded to the TUI.
- 2026-07-26: Live Codex transport recovered through the existing app-server
  without restarting either main pane. App-server status listed loop-bridge and
  its complete tool surface after reload.
- 2026-07-26: Diagnosed visible spam as one Codex verdict sent through both
  direct `tmux send-keys` and `loop-bridge.send_message`; the ledger itself had
  one message. Corrected the live idle Codex agent and changed future prompts to
  require bridge-only delivery and stuck-only status/receive calls.
- 2026-07-26: Focused changed-surface tests pass 150/150; delivery/prompt tests
  pass 86/86; build and diff check pass. Full suite is 795 pass / 4 known
  model/config expectation failures. Independent evaluation passed with no
  blockers; its two recovery advisories were addressed.

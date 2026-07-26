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
- 2026-07-26: Merged and rebuilt canonical loop. Synthetic Claude PreToolUse
  `git status --short` from `/private/tmp/harvto-loop47-base` created automatic
  job `9599b35e`, persisted the verified linked-worktree root, completed in 13
  seconds, and delivered exactly one worker result. Governess now shows 9 jobs,
  8 automatic adoptions, and exact skip reasons. Claude PID 56784 and Codex PID
  56786 remained unchanged; only the governess pane was narrowly respawned.
- 2026-07-26: Live delivery exposed a false-negative acknowledgement: Claude
  acted on a bridge message, but the project transcript version did not advance
  during the confirmation window and the active pane had no composer, so the
  durable message remained pending and was retried. Stopped the in-flight
  background worker, acknowledged the two already-consumed IDs, and verified
  the pending queue empty.
- 2026-07-26: Permanent confirmation now combines project-transcript and Claude
  hook-journal versions. A post-submit evidence advance with no composer
  confirms delivery even while Claude is actively processing; a foreign draft
  remains protected. The exact active-pane regression and full bridge file pass
  69/69. Canonical rebuilt and background bridge worker restarted as PID 14425;
  main pane PIDs remain unchanged.

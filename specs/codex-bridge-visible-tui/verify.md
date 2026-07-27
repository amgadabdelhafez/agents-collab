# Verify: Codex bridge activity visible in the TUI

- [x] Every bridge request reaches the visible-delivery dependency.
- [x] Bridge delivery never creates proxy app-server `turn/start` or
      `turn/steer` requests.
- [x] Successful visible submission is acknowledged once.
- [x] Failed visible submission remains pending.
- [x] Legacy and current Codex TUI ready states permit guarded submission.
- [x] Reconnect does not re-enable headless bridge injection.
- [x] Focused tests pass.
- [x] Full tests and build pass, or unrelated baselines are recorded.
- [x] Live pane, thread transcript, and `bridge.jsonl` show the same canary.
- [x] Live tmux Claude messages bypass unacknowledged channel delivery.
- [x] Headless Claude channel notifications still deliver and acknowledge.
- [x] The worker drains Claude while Codex remains owned by its tmux proxy.
- [x] Live Claude pane and `bridge.jsonl` show the same post-transition canary.

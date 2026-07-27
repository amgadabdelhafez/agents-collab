# Tasks: Codex bridge activity visible in the TUI

- [x] Add regression tests reproducing idle headless `turn/start` delivery.
- [x] Route every bridge request through guarded Codex pane submission.
- [x] Remove proxy-originated bridge `turn/start` and `turn/steer` behavior.
- [x] Verify acknowledgement, retry, reconnect, build, and full-suite behavior.
- [x] Deploy narrowly and prove one bridge request in the live Codex TUI.
- [x] Add the live-tmux Claude route and preserve the headless channel route.
- [x] Keep Claude/non-Codex worker draining active in Codex tmux-proxy mode.
- [x] Add regression coverage for routing, acknowledgement, and retry.
- [x] Build and deploy bridge support processes without restarting Codex.
- [x] Prove a post-session-transition Claude canary is visible end to end.

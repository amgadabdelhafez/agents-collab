# Task claude-bridge-low-latency

Created: 2026-07-26T05:48:24Z
Mode: emergent
Description: Attempt guarded visible Claude delivery synchronously before worker fallback

## What I changed

- Added Claude to the synchronous visible-tmux delivery targets used by
  `send_message`; failed or not-ready submissions remain durable and fall back
  to the bridge worker.
- Added a per-message atomic filesystem delivery claim. Immediate dispatch and
  the detached worker now re-check pending state under one claim before typing
  and acknowledging, preventing duplicate Enter submissions.
- Added focused tests for direct Codex-to-Claude delivery, preservation of a
  non-empty Claude draft, and the immediate-dispatch/worker race.
- Built and atomically installed the candidate `loop` binary. The installed and
  candidate SHA-256 are both
  `d4a8f01751c1dc0964ce9bcb9aeebd8a5f7901caa1c038e4c057b28b7954af3c`.
- Restored the run-38 Codex websocket app-server, tmux proxy, and dead Codex
  pane on the same persistent thread after the old remote client exited during
  transport replacement. Claude, Governess, and judge panes were not restarted.

## Why

Live run 38 queued Codex message `224f899f-1247-4e52-8507-fb17f8db5e20`
at 05:37:41.446Z and delivered it at 05:38:55.611Z. Claude had been idle, so
the measured 74-second gap came from the worker-only Codex-to-Claude route.

The first synchronous implementation exposed an immediate-dispatch/worker race
that could type Enter twice. The delivery claim closes that race without
removing the worker fallback.

## Notes

- Focused verification: 68 pass, 0 fail across bridge, proxy unit, and proxy
  reconnect integration tests.
- Build passes. `git diff --check` passes.
- Full suite: 616 pass, 4 existing unrelated Codex config/model expectation
  failures.
- Independent evaluation: PASS, including fresh-claim exclusion and stale-claim
  recovery after 30 seconds.
- Live proof message `d12cc542-b2c9-449c-b0c1-a06c4721391a` was written at
  06:02:07.427Z and acknowledged once at 06:02:07.578Z with reason
  `sent to claude tmux pane`: 151 ms. The complete message was visible in the
  Claude TUI while Claude continued its existing work.

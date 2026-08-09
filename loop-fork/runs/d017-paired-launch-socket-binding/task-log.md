# Task d017-paired-launch-socket-binding

Created: 2026-08-09T18:40:45Z
Mode: planned
Description: Bind every paired launch, readiness, pane, attach-recovery, and failed-start tmux operation to the manifest socket; reject unknown socket before resource creation.

## What I changed

- Persisted the resolved socket before the first paired tmux probe.
- Bound all paired startup tmux spawn, pane capture, send, attach, and recovery
  operations to that socket.
- Preserved live reattach pane identities and cleared them only for a confirmed
  cold recreation.
- Added exact-socket and degraded composer coverage.

## Why

Recorded ownership and runtime effects must address the same tmux server.

## Notes

- Focused tmux and socket suites: 158 passed, 0 failed.
- Degraded malformed and undurable socket paths create zero tmux or persistent
  transport resources.
- Modernization and product lanes were not touched.

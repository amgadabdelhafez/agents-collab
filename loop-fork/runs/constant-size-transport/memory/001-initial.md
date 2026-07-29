---
seq: 001
date: 2026-07-29T16:40:57Z
trigger: task-start
topic: initial
---

## Decided

- Persist complete composed launch charters inside the run directory and bind
  them by path, byte count, and SHA-256 in the manifest.
- Keep launch bootstraps below 1 KiB and fail closed on a hash mismatch.
- Deliver Codex bridge messages through app-server without a tmux dependency.
- Notify interactive non-Codex panes with a constant-size nudge; agents pull
  bodies from `receive_messages` and only that pull resolves delivery.
- Hold deployment for exact-SHA review plus the T4/census release.

## Still open

- Final manifest field shape and migration behavior for older runs.
- Notification retry interval and how per-message notification evidence is
  represented without resolving the inbox.
- Whether one constant-size nudge policy should cover every interactive
  non-Codex provider or initially Claude only; tests should favor the common
  policy unless a provider constraint is found.

## Where we are

- Specs and Harness plan are ready; no runtime source has been edited.
- Live run 99 remains untouched.

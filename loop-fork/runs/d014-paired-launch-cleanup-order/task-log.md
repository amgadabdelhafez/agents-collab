# Task d014-paired-launch-cleanup-order

Created: 2026-08-09T18:29:35Z
Mode: planned
Description: Make an owned failed paired launch durably non-owning before exact proxy and app-server teardown, preserving the primary startup error and cross-lane isolation.

## What I changed

- Reordered owned failed-start cleanup so the exact tmux session is removed
  and the manifest becomes terminal before proxy teardown is requested.
- Bound failed-start liveness and kill commands to the manifest socket.
- Kept transport-field clearing as a second durable update after exact owned
  cleanup completes.
- Required successful kill plus a same-socket absence re-probe before any
  terminalization or transport teardown.
- Preserved active manifest and exact transport identity on kill, re-probe, or
  terminal-write uncertainty.

## Why

The proxy's active-tmux HTTP 409 guard was correct. The launcher was asking for
shutdown before revoking its own active ownership claim.

Verification: focused tmux suite 110/110, scoped static check and build pass,
and independent zero-write review PASS after two degraded-path corrections.

## Notes

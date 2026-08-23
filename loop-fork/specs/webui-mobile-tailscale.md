# webui-mobile-tailscale

Task completed 2026-08-23T06:50:14Z, mode planned.

## What was built

- Reworked the phone header so the full page identity, appearance selector,
  and an accessible compact connection status remain visible down to 320px.
- Made the bottom navigation safe-area aware while preserving the existing
  fleet and run-workspace mobile information hierarchy, including the required
  `viewport-fit=cover` browser contract.
- Added `bun run web:tailscale`, which discovers healthy Tailscale state and
  binds Vite only to the exact `100.64.0.0/10` address.
- Extended the live-data Host and Origin guard from one expected localhost to
  an exact configured allowlist, preserving same-host enforcement for the
  derived Tailscale IP and MagicDNS name.
- Added an earlier all-route exact Host guard so Vite root and asset responses
  cannot rely on Vite's permissive numeric-host behavior.
- Added fail-closed resolver tests and operator documentation.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-23T06:11:43Z)

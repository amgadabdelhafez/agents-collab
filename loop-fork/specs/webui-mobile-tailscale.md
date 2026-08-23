# Web UI mobile and Tailscale access

## Outcome

The read-only Loop Web UI is comfortable to use from a phone and can be
started on the Mac's private Tailscale interface without listening on the LAN.

## Mobile contract

- At widths from 320px through 760px, the global header preserves the current
  page title, an accessible connection state, and appearance selection without
  horizontal overflow.
- Mobile navigation remains a fixed, thumb-reachable bottom bar and respects
  device safe-area insets.
- Fleet and run-workspace content remains readable at 320px, 390px, and 430px.
- Desktop layout and semantics remain unchanged above the mobile breakpoint.

## Tailscale contract

- `bun run web:tailscale` discovers the supported Tailscale CLI, requires a
  healthy running node, and selects only a valid Tailscale IPv4 address.
- The server listens on that exact Tailscale address, never `0.0.0.0`, so the
  new access path is not exposed to the ordinary LAN.
- The launcher prints both the private IP URL and the node's MagicDNS URL when
  available, and Vite admits only that exact MagicDNS host in addition to its
  normal IP/localhost behavior.
- Invalid status JSON, stopped Tailscale, missing identity, invalid ports, and
  non-Tailscale addresses fail closed before starting Vite.

## Verification

- Focused unit tests cover address/status/port parsing and fail-closed cases.
- Server-rendered tests preserve the accessible header and navigation contract.
- Browser evidence covers fleet and run views at 320px, 390px, and 430px with
  no horizontal overflow and no browser console errors.
- A real isolated listener proves the process is bound to the Tailscale address
  and is reachable through both the Tailscale IP and MagicDNS name.
- Web build, full sequential regression, committed diff check, and independent
  exact-SHA review pass.

## Non-goals

- No public Internet exposure, LAN-wide listener, authentication replacement,
  Tailscale ACL mutation, persistent Tailscale Serve configuration, runtime
  control, or write capability.

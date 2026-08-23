# Task webui-mobile-tailscale

Created: 2026-08-23T06:11:43Z
Mode: planned
Description: Add a phone-first Web UI layout and private tailnet-only launch path.

## What I changed

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
- Added fail-closed resolver tests and operator documentation.

## Why

The existing breakpoint avoided overflow but compressed the page identity
behind long global controls. Remote static assets were reachable when manually
bound to Tailscale, but the live endpoint correctly rejected the non-local Host
header. This slice makes the phone hierarchy intentional and admits only the
two exact private hosts derived from healthy Tailscale status.

## Notes

- Focused resolver suite: 6 tests, 15 assertions, zero failures.
- Exact Host/Origin projection suite: 33 tests, 191 assertions, zero failures.
- Server-rendered Web UI suite: 5 tests, 54 assertions, zero failures.
- Full sequential regression: 82 test files, 1,659 tests, zero failures.
- Production Web UI build and scoped formatting checks pass.
- Repository-wide `bun run check` remains stopped by 89 formatting diagnostics
  in generated Harness JSON, including the inherited completed-run baseline;
  the ten changed source, test, configuration, and package files pass the
  scoped check without diagnostics.
- The mandatory root `scripts/verify.sh` reaches the same repository-wide lint
  stop before later gates; it reports no changed product or test diagnostic.
- Live browser evidence covers 320x700, 390x844, and 430x932 with zero
  horizontal overflow and no browser warnings or errors.
- Real listeners are exact `127.0.0.1:46327` and `100.64.0.14:46327`; there is
  no wildcard listener. Both the private IP and `sweetmac14.sweet.home` return
  the validated redacted live snapshot.
- Tailscale ACLs, Serve configuration, firewall state, and public/LAN exposure
  were not changed.

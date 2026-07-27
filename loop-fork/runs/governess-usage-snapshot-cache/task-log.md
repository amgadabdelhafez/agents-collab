# Task governess-usage-snapshot-cache

Created: 2026-07-27T04:43:58Z
Mode: planned
Description: Retain last successful Usage Tracker snapshot across transient fetch misses

## What I changed

- Return a pricing-only snapshot from the existing cached/bundled catalog when
  a configured tracker request times out, loses its connection, or returns a
  non-auth server error.
- Preserve missing-secret and exhausted-authentication behavior.
- Add a success-to-timeout/503 regression that proves equal cost and no quotas.

## Why

Run 50's Usage Tracker request intermittently aborts at 1.5 seconds. Returning
no snapshot also discards locally available pricing, which blanks cost/rate for
one tick.

## Notes

Regression: yes
Regression id: governess-transient-cost-flicker
Regression symptom: Cost/rate becomes blank for a tick when Usage Tracker times out.
Regression guard: bun test tests/loop/governess-usage-limits.test.ts

## Verification

- Focused pricing/governess suites: 68 pass, 0 fail.
- Full suite: 828 pass, 4 unchanged baseline failures.
- Build and `git diff --check`: pass.
- `bun run check`: unavailable because `ultracite` is not installed here.
- Independent evaluator: PASS, no implementation findings.
- Live run 50: ten consecutive Codex samples retained `$8.82/$26`; the first
  three had no current quota snapshot, directly exercising local pricing.
- Pane isolation: Claude 27090, Codex 27092, and worker 27542 were unchanged.
- Governess doctor: all checks and journal health passed; bridge queue empty.

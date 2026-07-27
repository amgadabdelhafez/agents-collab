# Spec: Governess Usage Snapshot Cost Stability

## Problem

The live governess rebuilds every agent row on each tick. When the Usage Tracker
`/stats` request intermittently exceeds its 1.5-second timeout, the reader
returns no snapshot. Transcript metrics remain available, but Usage Tracker
pricing is not applied for that tick, so cost/rate changes to `—/—` and then
returns after the next successful request.

Live run 50 recorded alternating successful snapshots and `AbortError` misses,
and the Codex cost cell visibly alternated with them.

## Goal

Keep cost estimates stable across transient Usage Tracker failures by returning
a pricing-only snapshot from the local cached or bundled catalog whenever a
configured, authenticated tracker request fails transiently.

## Non-goals

- Fabricating quota percentages or reset times during a missing observation.
- Treating rejected credentials as a healthy tracker response.
- Changing Usage Tracker timeout, scraping, pricing rates, or quota semantics.
- Restarting Claude, Codex, or the utility worker.

## Acceptance criteria

- [x] A timeout, connection failure, or non-auth HTTP failure returns a
      pricing-only snapshot from the normal cached/bundled catalog.
- [x] Applying that fallback keeps current Claude and Codex costs non-zero.
- [x] The fallback contains no fabricated agent quota windows.
- [x] Missing credentials and exhausted authentication failures remain disabled.
- [x] Focused tests, full suite, build, repository verification, and independent
      evaluation pass or isolate unchanged baseline failures.
- [x] Live run 50 keeps the Codex cost cell populated across multiple refreshes
      after replacing only the governess pane; other pane PIDs remain unchanged.

## Open questions

None.

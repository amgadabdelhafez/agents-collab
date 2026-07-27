# utility-worker-runaway-guard

Task completed 2026-07-27T16:16:55Z, mode planned.

## What was built

- Captured the loop-53 runaway signature before implementation: 737 consecutive
  denied tool calls, 18,869,682 tokens, $3.99, and monthly-key exhaustion.
- Added the spec before source changes.
- Added a three-consecutive-broker-rejection breaker that resets on a broker
  success.
- Added a third-identical-call breaker that fails before executing the third
  call.
- Added an emergency ceiling that fails before provider call 65, while keeping
  the 15-minute external runtime bound and intentionally retaining no token or
  dollar cap.
- Added four local OpenAI-compatible endpoint regressions for the two breakers,
  rejection reset behavior, and the emergency ceiling.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-27T16:04:00Z)
- 002 - runaway guard spec approved and implementation starts (2026-07-27T16:04:52Z)
- 003 - independent pass and live atomic install verified (2026-07-27T16:16:50Z)

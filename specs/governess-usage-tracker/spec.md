# Spec: Governess Usage Tracker Contract

## Problem

The governess board no longer matches the deployed Usage Tracker contract.
Authentication moved to `~/.usage-tracker/config`, quota windows are dynamic
`limits[]` records, reset instants may be numeric timestamps, and current models
are absent from the governess's old pricing table. The board consequently shows
missing Claude quota, labels Codex weekly quota as session quota, omits resets,
and renders zero cost under a misleading `SPEND` heading.

## Goal

Consume the current authenticated Usage Tracker contract without losing
current-loop scope: render only real aggregate quota windows, use exact reset
instants, and estimate each agent's current-loop replacement value with the
Usage Tracker pricing catalog semantics.

## Requirements

1. Authentication checks explicit environment credentials first and retries
   `~/.usage-tracker/config` after a rejected or absent token. Tokens are never
   logged or persisted by governess.
2. Quota parsing prefers aggregate entries from `claude_quota.limits[]` and
   `codex_quota.limits[]`, classifies them by `window_kind`, and retains the old
   scalar fields only as a compatibility fallback.
3. A provider with no session window must not display a fabricated session
   percentage or reset. Model-specific limits do not replace an available
   aggregate limit.
4. Reset countdowns prefer `reset_at` epoch timestamps and fall back to the
   normalized `reset` string.
5. Pricing uses Usage Tracker catalog semantics: Claude API USD rates, Codex
   credit rates plus the explicitly estimated USD-per-credit value, effective
   dates, longest model-prefix matching, and pricing coverage.
6. Cost remains scoped to the current loop transcript. Account-wide day/week
   totals from Usage Tracker must not be presented as current-loop value.
7. The board labels the metric as an estimate (`EST RUN / H` and `Σ est`) and
   fails closed when pricing is unavailable.
8. The unified agent table remains at most 180 visible columns.

## Acceptance

- [x] Live Claude quota matches Usage Tracker session and weekly values/resets.
- [x] Live Codex shows only its real aggregate weekly window.
- [x] `claude-opus-5` and `gpt-5.6-sol` receive non-zero current-loop estimates
      with 100% pricing coverage.
- [x] A stale `.env` token can fall back to the working config token.
- [x] Focused tests, complete governess tests, build, and `git diff --check`
      pass.
- [x] Only the governess pane is replaced live; agent PIDs stay unchanged.

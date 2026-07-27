# Spec: Governess summary completeness and retry

## Problem

Governess accepted a truncated local-model summary ending in
`Next: The supervisor` as a successful refresh. It advanced `summaryTick`, left
the incomplete text visible, and deferred the next attempt for the full normal
refresh interval. The board continued ticking, which made only the Progress and
Next content appear frozen.

## Goal

Reject structurally incomplete Project/Objective/Progress/Next summaries,
preserve the last usable text, and retry an invalid summary on a short bounded
cadence. A persisted invalid summary from an older runtime must be retried soon
after a Governess restart.

## Non-goals

- Replacing the local summary model.
- Increasing normal summary-call frequency.
- Restarting Claude or Codex.
- Treating the generated summary as an authority over bridge rulings or source
  artifacts.

## Acceptance criteria

- [x] A summary must contain Project, Objective, Progress, and Next in order.
- [x] Empty or obviously truncated final sections are rejected.
- [x] Invalid output never replaces the last displayed summary.
- [x] Invalid summaries retry after a short backoff instead of every tick or the
      full normal interval.
- [x] A persisted invalid summary becomes due on the short retry cadence after
      restart.
- [x] Focused tests, full tests, build, and a live Governess-only restart pass,
      with unrelated baseline failures documented.

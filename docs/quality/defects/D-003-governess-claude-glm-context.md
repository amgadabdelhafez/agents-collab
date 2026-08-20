# D-003: Governess reports incorrect Claude and GLM context

Status: queued
Severity: P2
Subsystem: Governess usage and context observability
First confirmed: agents-collab Run 15, 2026-08-07

## User-visible failure

The Governess pane does not show authoritative context information for Claude
and GLM. In the confirmed Run 15 snapshot, Claude was rendered as
`16k/200k 8%`, while the live Claude UI exposed its own context state. The GLM
helper row did not expose a comparable used/max context value at all. The two
rows therefore cannot be trusted for context-pressure decisions.

## Required behavior

- Derive the active model identity, context-window maximum, and consumed tokens
  from the live run's provider/session evidence.
- Render used tokens, maximum tokens, and percentage with the same documented
  meaning for Claude and GLM.
- Do not substitute routing counters, cache counters, missing-context counts, or
  a static model default for live context usage.
- If authoritative provider evidence is unavailable or stale, render an
  explicit unavailable/stale state rather than a plausible number.

## Acceptance tests

- Producer-backed Claude and GLM fixtures independently vary model, context
  maximum, consumed tokens, absent data, and stale data.
- Governess output matches the authoritative fixture values and percentage
  semantics for each provider.
- A live audit compares the pane against the current session/provider evidence
  for both rows.
- Missing or contradictory evidence fails closed and cannot render a normal
  numeric context value.

## Delivery lane

Implement in a fresh isolated governed loop. Do not mix this renderer and
accounting change into tmux socket normalization.

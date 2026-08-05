# Context pressure on the current handover lineage

## Objective

Restack the reviewed context-pressure handoff feature on exact supervisor-
concurred source commit `c842fac05aba5d5eb3658704d537ab1022a1916a`
without weakening any later handover safety behavior.

## Required behavior

- Retain the context-first pressure profiles, automatic-compaction precedence,
  preparation telemetry, observe/off modes, and enforce-mode activation from
  `specs/context-pressure-handoff/spec.md`.
- Retain all handover changes already present at the concurred source commit,
  including safe composer recognition, trailing subagent-stop handling,
  idempotent control delivery, validated bundles, and transaction-epoch
  preservation across a Governess restart, exact driver/reviewer effort carry,
  continuation digest binding, and one-time restart-frame reconciliation.
- A pressure-triggered handover must pin the current Governess epoch before any
  persisted state can be reloaded under a newer fencing epoch.
- The combined result must use the existing governed handover controller. It
  must not introduce a direct restart, kill, `/compact`, or `/rename` path.
- Producer-backed handover coverage must use an asymmetric non-default
  `driverEffort=high` fixture so a hardcoded-medium carry mutation fails.

## Authority boundary

This task ends at a committed exact-SHA supervisor review request. It does not
authorize install, deployment, live-loop mutation, merge, rebase, or push.

# Context pressure on the current handover lineage

## Objective

Restack the reviewed context-pressure handoff feature on exact installed source
commit `67e622d0aee4ef331acec3cebc58e34f7f2ec292` without weakening any later
handover safety behavior.

## Required behavior

- Retain the context-first pressure profiles, automatic-compaction precedence,
  preparation telemetry, observe/off modes, and enforce-mode activation from
  `specs/context-pressure-handoff/spec.md`.
- Retain all handover changes already present at the installed source commit,
  including safe composer recognition, trailing subagent-stop handling,
  idempotent control delivery, validated bundles, and transaction-epoch
  preservation across a Governess restart.
- A pressure-triggered handover must pin the current Governess epoch before any
  persisted state can be reloaded under a newer fencing epoch.
- The combined result must use the existing governed handover controller. It
  must not introduce a direct restart, kill, `/compact`, or `/rename` path.

## Authority boundary

This task ends at a committed exact-SHA supervisor review request. It does not
authorize install, deployment, live-loop mutation, merge, rebase, or push.

---
seq: 001
date: 2026-08-25T21:27:19Z
trigger: task-start
topic: initial
---

## Decided

- The durable adapter identity is socket path plus PID plus OS process-birth
  identity; session names are routing labels, not identity.
- `manifestRevision` is derived from exact accepted file bytes and is never
  serialized into those bytes.
- Resolved configuration is a frozen strict allowlist built only after paired
  options are applied.
- New Web-facing diagnostics require an explicit persisted adapter context and
  exact `tmux -S`; they do not acquire launch or mutation authority.

## Still open

- T-01 must consume these producer-owned fields through a side-effect-free read
  model. Legacy manifests must continue to surface identity/config as unknown.

## Where we are

T-00 implementation and independent exact-SHA review are complete. Harness
closure is the remaining administrative step.

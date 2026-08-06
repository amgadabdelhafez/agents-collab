---
seq: 001
date: 2026-08-06T01:02:21Z
trigger: task-start
topic: initial
---

## Decided

- Activate the existing Phase-0 model at paired launch, before tmux handoff.
- Keep artifacts below the canonical run directory and fail closed.
- Do not rewrite an already-live run during reattachment.
- Use committed Git state only and retain the non-authoritative boundary.

## Still open

- Exact-SHA supervisor review and release authority.

## Where we are

- Implementation and source verification are complete in the isolated
  `codex/world-model-activation` worktree.

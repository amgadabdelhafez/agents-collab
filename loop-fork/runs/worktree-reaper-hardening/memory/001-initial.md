---
seq: 001
date: 2026-08-06T01:11:42Z
trigger: task-start
topic: initial
---

## Decided

- Replace the old shell prototype instead of porting it unchanged.
- Use NUL-safe Git porcelain and exact HEAD ancestry against `origin/main`.
- Make process inventory a fail-closed prerequisite and revalidate on apply.

## Still open

- Exact-SHA supervisor review and integration authority.

## Where we are

- Implementation and producer-backed verification are complete in the
  isolated worktree. No cleanup or deployment has been applied.

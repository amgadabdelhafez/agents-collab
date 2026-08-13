---
kind: parked-idea
id: harvto-d5-silent-completion
status: parked
created_at: 2026-08-13T04:58:25Z
source_task: harvto-supervisor-defects
---

# harvto-d5-silent-completion

Idea captured 2026-08-13T04:58:25Z.

## Capture

D5 P1: make task completion emit durable supervisor-visible closure across restart/replay; reproduce runs finishing without close signal.

## Source

- Active task: harvto-supervisor-defects

## Promotion

Run:

```bash
./harness promote harvto-d5-silent-completion
```

---
kind: parked-idea
id: harvto-d15-teardown-process-orphans
status: parked
created_at: 2026-08-13T17:43:10Z
source_task: harvto-d3-pending-route
---

# harvto-d15-teardown-process-orphans

Idea captured 2026-08-13T17:43:10Z.

## Capture

D15 lifecycle P0: completed Governess teardown leaves manifest-owned launcher or Claude child processes alive; require positive PID liveness before teardown, direct absence proof after teardown, isolated fixture-owned processes only, no signals outside manifest ownership, and durable unresolved cleanup instead of false completion.

## Source

- Active task: harvto-d3-pending-route

## Promotion

Run:

```bash
./harness promote harvto-d15-teardown-process-orphans
```

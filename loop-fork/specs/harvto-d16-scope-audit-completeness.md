---
kind: parked-idea
id: harvto-d16-scope-audit-completeness
status: parked
created_at: 2026-08-13T17:43:03Z
source_task: harvto-d3-pending-route
---

# harvto-d16-scope-audit-completeness

Idea captured 2026-08-13T17:43:03Z.

## Capture

D16 campaign-integrity P0: scope audit can return a clean verdict while omitting Git-derived modified paths; require complete added, deleted, renamed/copied, staged, committed-range, and tracked-but-routing-ignored path enumeration plus consumer-side fail-closed count/hash reconciliation and a genuinely clean negative control.

## Source

- Active task: harvto-d3-pending-route

## Promotion

Run:

```bash
./harness promote harvto-d16-scope-audit-completeness
```

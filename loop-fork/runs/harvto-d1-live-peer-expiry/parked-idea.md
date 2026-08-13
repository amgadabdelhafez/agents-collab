---
kind: parked-idea
id: harvto-d1-live-peer-expiry
status: parked
created_at: 2026-08-13T04:58:19Z
source_task: harvto-supervisor-defects
---

# harvto-d1-live-peer-expiry

Idea captured 2026-08-13T04:58:19Z.

## Capture

D1 P0: reproduce and fix bridge TTL/dead-letter behavior that discards a message while its intended peer is live; preserve idempotency and prove no duplicate.

## Source

- Active task: harvto-supervisor-defects

## Promotion

Run:

```bash
./harness promote harvto-d1-live-peer-expiry
```

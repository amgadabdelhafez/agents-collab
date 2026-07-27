# Utility worker pool

## Requirements

- Run up to four utility jobs concurrently by default.
- Allow `LOOP_UTILITY_MAX_CONCURRENCY` to configure 1 through 8 slots.
- Keep excess eligible work in `pending-route`; do not start its claim timeout
  until a slot is available and a worker is actually spawned.
- Continue routing non-utility work even when worker slots are full.
- Preserve workspace verification, epoch fencing, and overlapping write-scope
  exclusion.

## Acceptance

- Four independent read-only jobs route and spawn together.
- A fifth remains pending until one active job becomes terminal.
- A later routing tick starts the queued job.
- Existing write-conflict and stale-worker tests remain green.

# Task harvto-d1-live-peer-expiry

Created: 2026-08-13T05:43:08Z
Mode: emergent
Description: D1 P0: reproduce and fix bridge TTL/dead-letter behavior that discards a message while its intended peer is live; preserve idempotency and prove no duplicate.

## What I changed
Reviewed fix commit 2986c38c4499cdd27162801880d5e4aef0f173c0 implemented tri-state target liveness, lazy memoized pane probing, retained-count ceiling, typed pre-accept backpressure, and confirmed-dead-only terminalization across bridge-store.ts, tmux-control.ts, bridge-dispatch.ts, and governess.ts.

## Why
Bridge TTL and dead-letter terminalization discarded a message while its intended peer was live, violating delivery idempotency. The fix requires positive pane_dead evidence before terminalization and preserves no-duplicate delivery.

## Notes
Claude zero-write PASS bridge c0c49af4-e3ed-4f7d-ada2-7fc562e28e23 on commit 2986c38c4499cdd27162801880d5e4aef0f173c0. Focused tmux test, named D1 regression, bridge, governess runtime, and all 77 serial test:ci files pass. D1 Harness closure requires this task-log entry before harness done succeeds.

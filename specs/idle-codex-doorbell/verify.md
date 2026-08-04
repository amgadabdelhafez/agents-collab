# Verification

- The worker-level fallback test fails before the implementation and passes
  after it.
- The fallback produces a `notified` journal row, no `delivered` row, and leaves
  the Codex message pending.
- Six consecutive no-work cycles use delays of 250, 500, 1000, 2000, 4000, and
  5000 ms; further idle cycles do not exceed 5000 ms.
- Existing direct-delivery and Claude-notification tests remain green.
- `scripts/verify.sh` and `bun run build` pass from `loop-fork/`.

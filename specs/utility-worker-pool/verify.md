# Verification

```bash
cd loop-fork
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts
bun test
bun run build
git diff --check
```

Live acceptance preserves all main pane PIDs, shows four simultaneous utility
workers, and prevents a queued fifth job from failing merely because all four
configured worker slots are occupied.

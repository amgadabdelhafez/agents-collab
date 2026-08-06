# Verification

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun test
bun run build
git diff --check
```

The regression must prove multiple retry-style waits create one watcher, keep
it open between cycles, and close both watcher and metadata probe exactly once
when the worker-scoped session exits.

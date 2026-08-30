# Verify

```bash
bun run test:file -- tests/loop/task-graph-runtime.test.ts
bun run test:file -- tests/loop/supervisor-orchestration-http.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```


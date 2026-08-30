# Verify: canonical task dependency DAG

```bash
bun run test:file -- tests/loop/task-graph-workflow.test.ts
bun run test:file -- tests/loop/temporal-task-graph.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

Require empty named failure sets and independent exact-candidate zero-write
review.


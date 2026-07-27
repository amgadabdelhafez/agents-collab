# Verification

```bash
cd loop-fork
bun test tests/loop/task-router.test.ts tests/loop/utility-runtime.test.ts
bun test
bun run build
git diff --check
```

Live acceptance requires the loop 47 worker/governess counters to remain
readable, no active job to be stranded, and Claude/Codex pane PIDs to remain
unchanged.

# Verification

```bash
cd loop-fork
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts
bun test
bun run build
git diff --check
```

Live acceptance preserves all main pane PIDs and prevents a queued third job
from failing merely because both configured worker slots are occupied.

# Verify: Utility Result Consumption

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun run build
cd ..
scripts/verify.sh
git diff --check
```

The focused regression must materialize the same durable job plus queued
handover produced in a live run, retrieve the result, and prove only the exact
unclaimed handover becomes delivered.

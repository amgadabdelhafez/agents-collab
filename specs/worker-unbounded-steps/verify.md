# Verification

```bash
cd loop-fork
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts
bun test
bun run build
git diff --check
```

Live acceptance: deployed by rebuilding `loop-fork/loop` only; all loop-48
PIDs (panes, governess, bridge worker) unchanged; subsequent utility jobs do
not fail with "worker reached its step limit without completion".

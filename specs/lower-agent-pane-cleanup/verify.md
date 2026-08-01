# Verify: Lower-Agent Pane Cleanup

```bash
cd loop-fork
bun test tests/loop/utility-observability.test.ts \
  tests/loop/utility-runtime.test.ts tests/loop/governess.test.ts
bun test tests/loop/utility-*.test.ts tests/loop/governess*.test.ts \
  tests/loop/bridge.test.ts tests/loop/tmux.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh --task-id <task-id>
```

Live proof records pane IDs/PIDs before and after replacing only utility and
governess, then captures the visible 58x20 and 176x20 output.

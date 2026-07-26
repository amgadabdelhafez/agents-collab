# Verify: Lower-Agent Release Integration

```bash
cd loop-fork
bun test tests/loop/task-router.test.ts tests/loop/utility-store.test.ts \
  tests/loop/utility-runtime.test.ts tests/loop/utility-tools.test.ts \
  tests/loop/openai-compatible.test.ts tests/loop/bridge.test.ts \
  tests/loop/codex-tmux-proxy.test.ts \
  tests/loop/codex-tmux-proxy.integration.test.ts tests/loop/tmux.test.ts \
  tests/loop/governess.test.ts tests/loop/run-state.test.ts \
  tests/loop/args.test.ts tests/loop/codex-app-server.test.ts
bun test
bun run build
git diff --check
```

Live-loop verification is identity-only: record loop-40 pane IDs/PIDs before
and after installation. Do not send input or restart a process.

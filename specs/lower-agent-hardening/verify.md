# Verify: Lower-Agent Hardening

```bash
cd loop-fork
bun test tests/loop/task-router.test.ts \
  tests/loop/utility-store.test.ts tests/loop/utility-tools.test.ts \
  tests/loop/utility-runtime.test.ts tests/loop/bridge.test.ts \
  tests/loop/governess.test.ts tests/loop/tmux.test.ts \
  tests/loop/codex-app-server.test.ts
bun test
bun run build
git diff --check
```

Use fake providers, fake PIDs, and disposable repositories/tmux sessions for
all destructive, timeout, and pane tests. Live-loop verification is identity
only: compare loop-43 pane IDs and PIDs without input, restart, or signal.

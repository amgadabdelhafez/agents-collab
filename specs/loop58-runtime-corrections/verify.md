# Verification

```bash
cd loop-fork
bun test tests/loop/claude-config-gc.test.ts \
  tests/loop/tmux.test.ts \
  tests/loop/utility-tools.test.ts \
  tests/loop/utility-runtime.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Live acceptance:

- Codex pane ID, PID, thread ID, and Harvto worktrees are unchanged.
- Prompt regressions prove a freshly loaded Claude reviewer waits without
  repository reads or helper packets until Codex sends a targeted request;
  the working live Claude is not restarted merely to exercise this prompt.
- A bounded five-file line-count packet completes through `count_lines` with
  no `command_denied`, no shell, and requestor-correct delivery.
- The run-scoped Claude config contains only the Loop-58 bridge; stale home
  bridges are gone. The current live registration may remain until the
  unchanged Claude process exits, and fresh runs add no home registration.
- Governess, Nanny, and Au Pair journals continue advancing after hot-swap.

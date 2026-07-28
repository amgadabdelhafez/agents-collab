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
- A freshly loaded Claude reviewer waits without repository reads or helper
  packets until Codex sends a targeted request.
- A bounded five-file line-count packet completes through `count_lines` with
  no `command_denied`, no shell, and requestor-correct delivery.
- The run-scoped Claude config contains only the live Loop-58 bridge, while
  `~/.claude.json` contains no loop bridge.
- Governess, Nanny, and Au Pair journals continue advancing after hot-swap.

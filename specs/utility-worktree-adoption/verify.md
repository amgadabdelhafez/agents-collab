# Verify: Utility Worktree Adoption

```bash
cd loop-fork
bun test tests/loop/task-router.test.ts tests/loop/utility-runtime.test.ts \
  tests/loop/utility-tools.test.ts tests/loop/bridge-mcp.test.ts
bun test tests/loop/utility-*.test.ts tests/loop/bridge*.test.ts \
  tests/loop/governess*.test.ts tests/loop/tmux.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Live proof records current pane IDs/PIDs, routes one bounded inspection whose
scope is inside `/private/tmp/harvto-loop47-base`, waits for a terminal utility
result, and verifies Claude/Codex IDs/PIDs are unchanged.

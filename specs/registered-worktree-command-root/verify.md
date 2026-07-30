# Verification

- `bun test tests/loop/governess-hooks.test.ts`
- `bun run check`
- `bun run test:ci`
- `bun run build`
- `git diff --check`
- Regression assertions prove the routed request uses the verified linked
  worktree and that unrelated explicit workdirs create no request.
- `runs/registered-worktree-command-root/eval.json` records the final results.

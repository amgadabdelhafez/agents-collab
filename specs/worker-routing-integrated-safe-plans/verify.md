# Verification

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts tests/loop/governess-hooks.test.ts tests/loop/task-router.test.ts tests/loop/utility-observability.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts tests/loop/utility-tools.test.ts tests/loop/utility-workspace.test.ts
bun test
bun run build
git diff --check
../scripts/verify.sh worker-routing-integrated-safe-plans worker-routing-integrated-safe-plans
```

Live acceptance records candidate/canonical/global binary hashes, exact pane
PIDs and dimensions before/after, the restarted governess PID, installed
breaker/tool strings, routing row output, and green `loop governess doctor 53`.
The terminal board has no DOM; exact `tmux capture-pane` text assertions are the
UI verification artifact.

# Full-suite baseline comparison

- Candidate `bun test`: 1,024 passed, 4 failed across 1,028 tests.
- Untouched live worktree rerun of the failing files: 25 passed, the same 4
  failed.
- Failures are outside this task's diff:
  - one fixture expects `gpt-5.5` while the current configured model is
    `gpt-5.6-sol`;
  - three Codex launcher mocks use matchers that the current Bun canary reports
    as exact-shape mismatches.
- The task boundary suite is independently green: 435 passed, 0 failed.
- `bun run build` and `git diff --check` pass.

Commands:

```text
bun test
bun test tests/loop/paired-options.test.ts tests/loop/runner.test.ts
bun test tests/loop/delegation-policy.test.ts tests/loop/governess-hooks.test.ts tests/loop/task-router.test.ts tests/loop/utility-observability.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts tests/loop/utility-tools.test.ts tests/loop/utility-workspace.test.ts tests/loop/governess.test.ts
bun run build
git diff --check
```

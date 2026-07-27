# Verification

```bash
cd loop-fork
bun test tests/loop/utility-context.test.ts tests/loop/task-router.test.ts tests/loop/bridge-utility.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-observability.test.ts tests/loop/utility-workspace.test.ts tests/loop/utility-tools.test.ts
bun test
bun run build
git diff --check
./harness verify unit -- bun test tests/loop/utility-context.test.ts tests/loop/task-router.test.ts tests/loop/bridge-utility.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-observability.test.ts tests/loop/utility-workspace.test.ts tests/loop/utility-tools.test.ts
./harness preflight --json utility-context-capsules
./harness stop-gate --json utility-context-capsules
```

Installation proof records candidate/canonical/global hashes and installed
feature strings. No live tmux restart is required because loop 53 no longer
exists; subsequently started loops load the installed binary.

# Verify

```bash
cd loop-fork
bun test tests/loop/governess-exit.test.ts
bun test tests/loop/governess*.test.ts
bun test
bun run build
cd ..
scripts/verify.sh
git diff --check
```

Mutation requirement: temporarily remove the `true` styled-capture argument
from `directInputIsSafe`, run the focused exit suite, and require the
styled-only ghost producer test to fail. Restore the implementation before any
commit or broader verification.

The live loop is observation-only for this change. Do not alter either agent
composer, restart a pane, or deploy a binary without fresh authority.

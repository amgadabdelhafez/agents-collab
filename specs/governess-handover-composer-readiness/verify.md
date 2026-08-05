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

The live loop is observation-only for this change. Do not alter either agent
composer, restart a pane, or deploy a binary without fresh authority.

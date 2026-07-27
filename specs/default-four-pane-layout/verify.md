# Verification

```bash
cd loop-fork
bun test tests/loop/tmux.test.ts
bun test
bun run build
git diff --check
```

Compare the generated split commands to loop 47's live proportions:
main region 60%, bottom region 40%, governess 75% of bottom width, worker 25%.

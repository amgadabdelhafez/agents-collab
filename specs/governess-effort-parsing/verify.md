# Verification

```bash
cd loop-fork
bun test tests/loop/governess.test.ts
cd ..
scripts/verify.sh governess-effort-parsing governess-effort-parsing
git diff --check
```

The tests must demonstrate that arbitrary narrative words after `effort` are
ignored, a valid bottom status-line value wins, and provider-derived effort is
preserved when no valid pane marker exists.

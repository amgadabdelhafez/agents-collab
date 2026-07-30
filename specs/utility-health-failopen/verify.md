# Verify: Utility Health Fail-Open

```bash
cd loop-fork
bun test tests/loop/utility-readiness.test.ts tests/loop/governess-hooks.test.ts tests/loop/utility-runtime.test.ts
cd ..
for run in 1 2 3 4 5 6; do evals/smoke/tmux-redraw-backpressure.sh; done
cd loop-fork
bun test
bun run build
cd ..
git diff --check
scripts/verify.sh
```

Inspect the live loop before any Governess-only activation: no active helper
jobs, Claude/Codex/helper/recon pane IDs recorded, and tmux control responsive.

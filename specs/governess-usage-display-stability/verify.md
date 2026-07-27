# Verify: Governess Usage Display Stability

## Automated

```bash
cd loop-fork
bun test tests/loop/governess-usage-limits.test.ts tests/loop/governess.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

## Live

- Capture all four pane PIDs before deployment.
- Replace only `harvto-loop-50:0.2` with the freshly built executable.
- Sample enough refreshes to include at least one Usage Tracker timeout.
- Require the Codex weekly limit and cost/rate to remain populated throughout.
- Run `loop governess doctor 50` from `/Users/amgad/harvto`.

## Rollback

- Any Claude, Codex, or worker PID changes.
- Any blank Codex transcript metric, weekly limit, or cost after warm-up.
- Any new journal, bridge, or doctor failure.

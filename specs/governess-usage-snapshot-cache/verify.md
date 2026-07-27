# Verify: Governess Usage Snapshot Cost Stability

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

- Capture Claude, Codex, governess, and worker PIDs before deployment.
- Replace only `harvto-loop-50:0.2` with the freshly built runtime.
- Sample several refreshes and require a non-empty Codex cost/rate cell.
- Run `loop governess doctor 50` and require all checks plus journal health.

## Rollback

- Any agent/worker PID changes.
- Any blank transcript metric or cost cell after a successful initial tick.
- Any new journal, bridge, or doctor failure.

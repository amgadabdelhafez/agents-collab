# Verify: Worker Routing Live Integration

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts \
  tests/loop/governess-hooks.test.ts \
  tests/loop/utility-tools.test.ts \
  tests/loop/utility-runtime.test.ts \
  tests/loop/utility-worker-runtime.test.ts \
  tests/loop/governess-usage-limits.test.ts \
  tests/loop/governess.test.ts
bun test
bun run check
bun run build
git diff --check
```

Live acceptance:

- Record `tmux list-panes -t harvto-loop-51:0` before and after deployment.
- Confirm Claude and Codex PIDs are unchanged.
- Confirm the installed executable hash equals the verified build hash.
- Run `governess doctor 51` from `/Users/amgad/harvto` and require pass.
- Sample the pane long enough to cover multiple refreshes; Codex identity,
  quota, and cost values must not disappear on transient tracker failures.
- Inspect new delegation records and report eligible versus intentionally
  rejected work without treating the cumulative job count as a capacity cap.
- Confirm at least one newly routed bounded read or Git inspection completes
  without denied-tool churn; report tool calls and failures for the canary job.

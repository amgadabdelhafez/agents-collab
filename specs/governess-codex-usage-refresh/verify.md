# Verify: Governess Codex Usage Refresh

## Automated checks

```bash
cd loop-fork
bun test tests/loop/governess-usage.test.ts tests/loop/governess.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

## Functional checks

| # | Check | Command / Assertion | Pass condition |
|---|---|---|---|
| F-01 | Late Codex binding | Focused governess test | Next refresh adopts thread ID. |
| F-02 | Changed Codex binding | Focused governess test | New non-empty ID replaces stale ID. |
| F-03 | Transient manifest failure | Focused governess test | Known-good ID is retained. |
| F-04 | Live board | Capture run 50 governess pane | Codex model/context/tokens/activity are non-empty. |
| F-05 | Process preservation | Compare tmux pane PIDs | Claude, Codex, and utility PIDs are unchanged. |

## Regression guards

- [x] Weekly-only Codex quota remains weekly-only and aligned.
- [x] Governess doctor passes with no pending or dead-lettered bridge controls.
- [x] No agent pane is respawned.

## Rollback conditions

- Codex row becomes blank again with a valid current manifest and rollout.
- Claude/Codex pane PID changes during deployment.
- Governess journal or doctor reports a new invariant failure.

## Eval output format

The independent evaluator writes `runs/governess-codex-usage-refresh/eval.json`
using the constitution's standard schema.

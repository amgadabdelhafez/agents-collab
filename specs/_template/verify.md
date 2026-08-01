# Verify: [Feature Name]
> This is the evaluator contract. The evaluator agent reads this file, not the spec.
> Every acceptance criterion in spec.md must appear here as a testable check.

## Automated checks

```bash
# Run all checks for this feature
scripts/verify.sh --task-id [task-id] --feature [feature-name]
```

## Functional checks

| # | Check | Command / Assertion | Pass condition |
|---|---|---|---|
| F-01 | [Description] | `[test command]` | Exit 0, no failures |
| F-02 | [Description] | `[test command]` | Exit 0 |

## UI checks (required if any UI was touched)

```bash
scripts/capture-ui.sh --route /[path] --out runs/[task-id]/screenshots/
```

| # | Route | Element / assertion | Pass condition |
|---|---|---|---|
| U-01 | `/[path]` | `[CSS selector or text]` present | Visible in screenshot + DOM |
| U-02 | `/[path]` | No console errors | `errors.json` is empty |

## Performance thresholds

| Metric | Threshold | How to measure |
|---|---|---|
| [e.g. page load] | [e.g. < 800ms p95] | `scripts/collect-o11y.sh --metric [name]` |

## Regression guards

These must NOT regress:

- [ ] [Existing flow 1] still passes its golden test
- [ ] [Existing flow 2] still passes

## Rollback conditions

If any of the following are true after merge, revert immediately:

- [Error rate] exceeds [X%] in [window]
- [Core user journey] fails in smoke eval
- [Performance metric] exceeds rollback threshold

## Eval output format

The evaluator writes `runs/<task-id>/eval.json`:

```json
{
  "task_id": "[task-id]",
  "feature": "[feature-name]",
  "timestamp": "[ISO-8601]",
  "checks": {
    "functional": { "passed": 0, "failed": 0, "details": [] },
    "ui": { "passed": 0, "failed": 0, "screenshots": [] },
    "performance": { "passed": 0, "failed": 0, "details": [] },
    "regression": { "passed": 0, "failed": 0, "details": [] }
  },
  "baseline_failures": [],
  "verdict": "pass | fail",
  "notes": ""
}
```

## Baseline failures

`baseline_failures` is an allowlist of **exact test names** that are known to fail
and are not caused by this task. It is never a count and never a flag:
`"baseline_failures": 4` and `"baseline_failures": true` are invalid records, as
is the retired `"result": "pass_with_baseline_failures"`. Tolerated-baseline
vocabulary in any `status`/`result`/`verdict` value (for example
`baseline_failures_only` or `pass_with_known_limitations`) is rejected the same
way: known failures are recorded as names on the allowlist or not at all.

**The allowlist must be empty to release.** `scripts/verify.sh` runs
`scripts/check-baseline-allowlist.py` against the run's `eval.json` and fails
while any name remains. A named entry is a blocker to fix or waive explicitly —
it is not a tolerance budget, so a task cannot inherit someone else's failures by
matching a number.

**The gate fails closed.** `verify.sh` requires `--task-id` (there is no default
artifacts dir), a missing or unreadable `eval.json` fails the run instead of
skipping the gate, and the regression evals
`evals/regression/baseline-allowlist-fail-closed.sh` and
`evals/regression/verify-requires-task-id.sh` pin both behaviors.

# Verify: [Feature Name]
> This is the evaluator contract. The evaluator agent reads this file, not the spec.
> Every acceptance criterion in spec.md must appear here as a testable check.

## Automated checks

```bash
# Run all checks for this feature
scripts/verify.sh --feature [feature-name]
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

## Fixture provenance (required when fixtures model another component/process)

- [ ] Each integration fixture derives from captured producer output and records
      producer name plus exact version/build.
- [ ] Capture command, UTC time, and relevant environment/protocol details are
      recorded next to the fixture.
- [ ] Raw bytes are retained, or a durable raw reference and SHA-256 are recorded
      when the raw capture cannot be committed safely.
- [ ] Any sanitization/normalization is deterministic, checked in, and records the
      normalized fixture SHA-256; no secrets or personal data enter Git.
- [ ] Hand-authored fixtures are labeled `synthetic` and are not used alone to
      certify a cross-component or cross-process seam.

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
  "verdict": "pass | fail",
  "notes": ""
}
```

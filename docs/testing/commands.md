# Test Commands
> Authoritative list of how to run every test type. Agents and hooks use this.

## Unit tests

```bash
# Run all unit tests
[your-unit-test-command]

# Run tests for a single module
[your-unit-test-command] [module-path]
```

## Integration tests

```bash
[your-integration-test-command]
```

## End-to-end / browser tests

```bash
[your-e2e-command]
# Uses Playwright/Cypress/other. Requires app to be running.
```

## Snapshot / golden tests

```bash
[your-snapshot-command]
# Update snapshots: [update-command]
```

## Full verify suite (used by hooks and CI)

```bash
scripts/verify.sh
# Runs: lint → typecheck → unit → integration → e2e (if app running)
```

## Coverage report

```bash
[your-coverage-command]
# Threshold: 70% minimum per subsystem (see quality-scorecard.md)
```

## Notes

- Integration tests require [describe any setup — DB, env vars, running services].
- E2E tests require the app running at `[URL]`. Start with: `[start-command]`.
- Flaky tests are tracked in `docs/quality/quality-scorecard.md` → Debt register.

# Baseline cleanup verification

## Acceptance checks

- `bun test tests/loop/bridge.test.ts` exits zero without a lingering runner.
- `bun test tests/loop/governess-exit.test.ts` exits zero without a lingering runner.
- `bun run test:ci` exits zero.
- `bun run check` reports zero diagnostics.
- `bun run build` exits zero.
- `git diff --check` exits zero.
- Parsed historical JSON before and after formatting is identical.
- `scripts/verify.sh baseline-cleanup baseline-cleanup` executes real lint,
  typecheck, build, tests, and baseline-allowlist checks and exits zero.
- `scripts/verify.sh` without a task identity exits two before running checks.
- The baseline gate rejects pending evals, non-empty lists, legacy status
  labels, and count/boolean allowances.
- Independent review reports no actionable correctness finding.

## Rollback conditions

- Bridge delivery or Governess teardown behavior changes outside deterministic
  cleanup.
- Any historical JSON key or value changes.
- The active loop or global runtime is modified.

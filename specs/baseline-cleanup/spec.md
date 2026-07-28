# Baseline cleanup

## Problem

The Caveman integration proved its focused behavior, but the repository cannot
currently claim a clean release baseline:

- `tests/loop/bridge.test.ts` and `tests/loop/governess-exit.test.ts` complete
  their assertions while leaving Bun alive with dangling child resources. In a
  sequential full-suite run this presents as timeouts, stale tmux delivery state,
  and a dangling process.
- `bun run check` reports 347 errors and one warning across historical run
  artifacts, source, and tests.

## Required outcome

1. Both lifecycle-heavy test files exit normally without an external timeout or
   residual test runner.
2. `bun run test:ci` passes with no baseline-failure allowance.
3. `bun run check` passes with zero diagnostics.
4. Historical JSON evidence may be formatted mechanically, but its parsed data
   must not change.
5. Source lint fixes must preserve bridge delivery, Governess teardown, routing,
   and Caveman behavior.
6. The active loop and globally installed runtime must not be restarted or
   replaced by this task.

## Non-goals

- No routing-policy, permission, model, or pane-layout changes.
- No broad lint-rule disablement to hide existing findings.
- No deletion or regeneration of historical run evidence.
- No remote push or live-loop deployment.


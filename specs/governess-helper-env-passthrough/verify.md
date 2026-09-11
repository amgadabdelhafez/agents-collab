# Verify: Governess helper-tier environment passthrough

## Functional checks

1. Run `LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux.test.ts`.
2. Confirm named passthrough behavior, raw-secret exclusion, and source-derived coverage tests pass.
3. Temporarily remove helper passthrough and capture failures from behavior and coverage tests.
4. Run `bun run check` and `bun run test:ci`.
5. Confirm `git diff --numstat` equals `git diff --numstat --ignore-all-space`.
6. Run `scripts/verify.sh` and record any task-independent blocker exactly.

## Regression guards

- Existing Governess environment entries remain in their current order.
- Absent or empty helper inputs produce no environment entry.
- Raw API key values never enter the persisted Governess environment.

## Eval output

Write `runs/governess-helper-env-passthrough/eval.json` with named check results,
mutation output paths, peer verdict, and final pass/fail verdict.


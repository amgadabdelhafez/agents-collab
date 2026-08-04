# Utility Task Admission Verification

Date: 2026-08-04
Base: `origin/main` at `aa74ee73ced6b03d153d31656bdd611be74c5be0`

## Passing evidence

- Focused producer and policy suite:
  `bun test tests/loop/task-router.test.ts tests/loop/bridge.test.ts tests/loop/bridge-guidance.test.ts tests/loop/governess-hooks.test.ts`
  passed 128 tests with zero failures.
- Changed-file static check:
  `bunx ultracite check` over the eight touched source/test files passed with
  zero diagnostics.
- `bun run build` compiled the 70-module binary successfully.
- `git diff --check` passed.
- The real bridge MCP producer rejects missing `work_shape` and the invalid
  value `parallel` before creating `utility/jobs.jsonl`.
- The real bridge MCP producer persists `"workShape":"separable"` for a valid
  request.
- Pure router fixtures keep `sequential`, `unknown`, and a legacy request with
  no field on the current driver with reason `work-not-separable`.

## Pre-existing broader-gate failures

- `bun run test:ci`, rerun outside the sandbox so localhost integration servers
  could bind, passed through the earlier named suites and then stopped at the
  existing test `preparePairedOptions creates a loop-scoped Codex home without
  global MCP config`: the fixture expects `model = "gpt-5.5"`, while current
  source writes `model = "gpt-5.6-sol"`.
- Global `bun run check` reports 205 pre-existing formatting errors in committed
  historical `runs/**` artifacts. The changed-file check above is clean.
- Repository-wide `bunx tsc --noEmit` has a large pre-existing error set across
  runtime and test files. The first production errors are in `bridge.ts`,
  `claude-sdk-server.ts`, and `codex-app-server.ts`; one existing router error
  says the selected tier may be undefined. This command is not an existing
  green gate on `origin/main`.

These failures are recorded rather than tolerated as a green release result.
No `eval.json` is authored by the implementer. An independent evaluator must
write it after reviewing the committed exact SHA.

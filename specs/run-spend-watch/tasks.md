# Tasks — run-level spend watch

- [x] Identify the 2026-07-26 removals and quote their commit messages / specs.
- [x] Confirm what spend control remains on main (`maxJobRuntimeMs` only).
- [x] Read `governess-usage.ts` (860) and `governess-usage-limits.ts` (727).
- [x] Establish that the existing `budgetUsd` alert is dead and aimed at
      subscription dollars rather than cash.
- [x] TDD `src/loop/governess-spend.ts` with `tests/loop/governess-spend.test.ts`.
- [x] Wire `watchRunSpend` into `governessTick`, observe-only by default.
- [x] Add wiring tests to `tests/loop/governess.test.ts`.
- [x] Document the `LOOP_SPEND_*` env knobs in `constants.ts`.
- [x] Verify: full suite, build, and both repo baselines unmoved.

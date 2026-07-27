# Task compound-worktree-observability

Created: 2026-07-27T19:53:22Z
Mode: planned
Description: Safely decompose read-only compounds, recover registered worktrees, and add worker detail to governess

## What I changed

- Added fail-closed `;` and mixed `;`/`&&` decomposition for one through six
  independently broker-satisfiable read stages, with bounded literal `echo`
  labels omitted from execution.
- Added a quote-aware, 1024-character leading `cd <literal> &&` scanner that
  recovers a workspace hint without parsing or trusting the command remainder.
- Added worker performance, load, context-capsule, and tool-failure aggregates
  plus three stable, width-clipped governess rows.
- Saturated malformed numeric aggregates, bounded cache ratios, and restricted
  displayed tool errors to short code-shaped metadata.
- Preserved compact per-stage stderr suppression before `;`, `&&`, and `|`.
- Added a Loop 54 replay that contains no command or prompt text in its output.

## Why

The full-command lexer made common read-only inspection groups indivisible and
also hid a valid leading linked-worktree path when an unsupported or very long
remainder followed it. The governess had routing totals but not enough data to
judge worker usefulness, latency, cost, context coverage, or broker failures.

## Notes

- Loop 54 replay: 146 prior compound rejects; 3 become structured read plans.
  The other 143 remain gated. One of two prior workspace-unverified Bash events
  now recovers its leading worktree hint; the unsafe remainder still rejects.
- Focused verification: 316 tests passed across routing, hook, workspace,
  observability, and governess suites; 65 terminal-board tests passed.
- Full suite baseline: 1045 passed and the same 4 unrelated Codex configuration
  expectation failures remained in `paired-options.test.ts` and
  `runner.test.ts`.
- Independent review passed after its four findings were fixed and
  regression-tested.
- `bun run build`, `git diff --check`, and the repository `scripts/verify.sh`
  wrapper passed. `bun run check` remains blocked by the inherited repository
  formatting/complexity baseline documented in the independent review.

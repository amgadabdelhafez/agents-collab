# Verification Evidence

## Automated

- Harness unit attempt 002: `bun run test:ci` passed with 1,099 tests and zero
  failures. Artifact: `artifacts/unit/verify.log`. After the live summary
  canary exposed bridge-envelope pollution, two regressions were added and the
  full suite passed again with 1,101 tests and zero failures.
- Focused changed-area suite: 547 tests passed.
- Post-refactor Pi/Governess/Recon/Tmux suite: 140 tests passed.
- Independent tier-capacity regression file: 45 tests passed.
- `bun run build` passed after the final test addition.
- `git diff --check` passed.
- Root `scripts/verify.sh` completed, but its lint/typecheck/test commands remain
  unconfigured placeholders; Harness verification is the executable gate.
- The repo-wide Ultracite check still reports pre-existing diagnostics in large
  legacy files. Changed hunks were checked narrowly and new diagnostics were
  corrected.

## Independent evaluator

Local Qwen returned `pass` with no findings. See `independent-review.md`.

## Live Loop 57

- Installed binary SHA-256:
  `ecc0e1f4743769eaf682ea96b42b30b48b4edc4108f2819cf29d6f663feb1c9b`.
- Claude `%0` remained PID `70452`; Codex `%1` remained PID `70454`.
- Hot-swapped Governess `%2`, Nanny `%4`, and Au Pair `%3` only.
- Added Recon `%6`, `%7`, `%8` as the full-width bottom row.
- Governess is 187 columns; the Nanny/Au Pair column is 47 columns, preserving
  the requested 4/5 to 1/5 width ratio.
- Canary `8a7b21f4-2e12-427f-8fec-8f6b225ded67` routed to Nanny, adopted the
  registered Loop 57 worktree, completed with three brokered tools, and was
  visible in Recon.
- Routing advanced from 11/87 to 12/88; bridge pending remained zero.
- No route event collision occurred after the hot-swap. The last historical
  collision was at `2026-07-28T00:36:05.545Z`.
- Governess summary Objective is exactly the launch mission after a real helper
  delivery; bridge envelopes and composer placeholders are excluded.

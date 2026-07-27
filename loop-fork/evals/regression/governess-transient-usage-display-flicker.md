# Regression Eval: governess-transient-usage-display-flicker

Generated: 2026-07-27T05:14:24Z
Source task: `governess-usage-display-stability`
Status: draft

## Failure Symptom

- Codex limits alternate between a weekly tracker value and a partial fallback every few refreshes.

## Guard Evidence

- tests/loop/governess-usage-limits.test.ts

## Verification Artifacts

- `integration`: `runs/governess-usage-display-stability/artifacts/integration/verify.log` (sign-off-granted)
- `smoke`: `runs/governess-usage-display-stability/artifacts/smoke/verify.log` (pass)
- `unit`: `runs/governess-usage-display-stability/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governess-transient-usage-display-flicker
Regression symptom: Codex limits alternate between a weekly tracker value and a partial fallback every few refreshes.
Regression guard: tests/loop/governess-usage-limits.test.ts

Verification:

- Focused: 70 pass, 0 fail.
- Full: 830 pass, 4 unchanged environment-sensitive Codex model/config failures.
- Build: pass.
- Root `scripts/verify.sh`: pass placeholder checks.
- `bun run check`: baseline/generated findings remain; changed usage reader and
  test files have no diagnostics, while `governess.ts` reports existing debt.

Live acceptance:

- Deployed SHA-256 `2cfa6f42ab50cbd28e3a2eceb2546de02ee7b58f0449c07a6dfd0415d401d9e9`.
- Respawned only `harvto-loop-50:0.2`; Claude `27090`, Codex `27092`, and worker
  `27542` were preserved. New governess PID: `32762`.
- After one warm-up tick, 24 consecutive samples retained Codex `W9` and a
  populated `$12.xx/$28` cost/rate cell.
- The tracker independently timed out twice during that observation, at
  22:10:14 and 22:10:34.
- `governess doctor 50` passed every check with a healthy journal, current
  index, and zero pending, expired, or dead-letter bridge entries.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

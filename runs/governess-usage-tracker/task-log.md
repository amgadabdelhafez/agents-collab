# Task log: governess-usage-tracker

## Scope

Align governess quota, reset, authentication, and current-loop estimate fields
with the deployed Usage Tracker API contract.

## What I changed

- Retried `~/.usage-tracker/config` after an absent or rejected explicit token,
  without logging or persisting credentials.
- Preferred aggregate `limits[]` quota windows and kept scalar fields only as
  compatibility fallback. Codex no longer receives a fabricated session row.
- Preserved numeric `reset_at` instants and parsed the API's compact reset text
  forms such as `2:30pm` and `Jul 27 at 6pm`.
- Added dated, longest-prefix Usage Tracker catalog semantics. Claude uses API
  USD rates; Codex uses credit rates and the API's estimated USD-per-credit
  value. Estimates remain scoped to each live loop transcript.
- Relabeled the UI to `EST RUN / H` and `Σ est`, rendered compact `S/W/A`
  window labels, and retained the single merged row per agent.

## Verification

- Focused quota/auth/pricing and board suites: 72 passed, 0 failed.
- Complete governess plus tmux suites: 194 passed, 0 failed.
- Compiled binary: passed.
- `git diff --check`: passed.
- Live Usage Tracker adapter: Claude `S84/W41`, Codex `W17` only; both current
  models had 100% pricing coverage.
- Live loop-34 board after 1-hour cache-write pricing: Claude estimated run
  value `$30.29`; Codex `$9.23` at the observed tick; row widths 179 visible
  code points, below the 180-column cap.
- Narrow pane replacement: governess PID `76881` -> `6469`; Claude PID `10483`
  and Codex PID `10485` remained unchanged.

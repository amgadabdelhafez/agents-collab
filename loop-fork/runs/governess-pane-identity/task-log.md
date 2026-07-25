# Task governess-pane-identity

## What I changed

- Added one canonical governess pane identity containing the full tmux session,
  explicit run number, and absolute working path.
- Applied the identity to both the border's `@loop_label` and tmux's native
  `pane_title`.
- Reapplied the identity on startup and every supervision cycle so the title
  self-heals after process or client title changes.
- Left agent pane labels and composer controls unchanged.

## Verification

- Focused governess tests: 54 passed, 0 failed.
- Full suite: 602 passed, 4 failed; the four failures are the known unrelated
  Codex default-model/mock expectation baseline.
- Build: passed.
- Live `harvto-loop-34`: both title fields exactly matched
  `● governess · harvto-loop-34 · run 34 · /Users/amgad/harvto`.
- Claude PID `10483` and Codex PID `10485` were preserved during the focused
  governess refresh; their composer lines were unchanged.
- Claude and Codex native pane titles were unchanged by the final refresh.
- Screenshot: `artifacts/ui/governess-pane-identity.png`.
- Structural assertion capture: `artifacts/ui/pane-identity.txt`.
- Independent evaluator: PASS with no actionable findings; report saved at
  `artifacts/evaluator-review.md`.

Regression: yes
Regression id: governess-pane-generic-title
Regression symptom: The governess pane is labeled generically and its native tmux title is the host name, hiding the loop identity and path.
Regression guard: tests/loop/governess.test.ts

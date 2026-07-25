# Task governess-header-identity

## What I changed

- Merged the full loop name and absolute path into the first time/status line.
- Removed the redundant `governess` and explicit `run 34` text from the board;
  those are already represented by the pane title and `harvto-loop-34`.
- Shortened both tmux governess title fields to
  `governess.harvto-loop-34`.
- Preserved per-cycle self-healing and agent-pane isolation.

## Verification

- Focused governess tests: 55 passed, 0 failed.
- Full suite: 603 passed, 4 failed; the four failures are the known unrelated
  Codex default-model/mock expectation baseline.
- Build and diff check: passed.
- Live `harvto-loop-34` showed the exact merged first line and short pane
  title, with no redundant `governess` or `run 34` in the board.
- Claude PID `10483` and Codex PID `10485` were preserved; both composer lines
  were unchanged.
- Screenshot: `artifacts/ui/governess-header-identity.png`.
- Structural capture: `artifacts/ui/pane-layout.txt`.
- Independent evaluator: PASS with no actionable findings; live board uses 16
  of 17 rows. Report: `artifacts/evaluator-review.md`.

Regression: no

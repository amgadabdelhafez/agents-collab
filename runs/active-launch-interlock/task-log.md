# Active launch interlock

- Filed incident: Harvto runs 106 and 107 were launched 24 seconds apart from
  one authorization against the same worktree and branch. Run 107 was stopped;
  run 106 remained authoritative and was not used as a fixture.
- Added `--workspace` canonical registered-worktree binding and persisted the
  full symbolic branch ref, launch claim, and source charter SHA-256 before
  task resolution or agent startup.
- Added a short repository lock, exclusive numeric run-directory reservation,
  fail-closed active/live/unknown/legacy conflict checks, atomic manifest
  replacement, explicit resume reuse, and owned-only tmux cleanup.
- Added deterministic unit, process-contention, lifecycle, and tmux-race
  coverage plus an isolated compiled smoke with fake Gemini/Cursor TUIs, an
  isolated HOME, and a unique tmux socket.
- Focused verification passed. Full Harness-recorded `bun run test:ci`, lint,
  typecheck, and build passed. The root verifier then passed lint, typecheck,
  compiled build, every sorted test file, and the empty named baseline
  allowlist. Exact-SHA review remains the deployment gate.

Regression: yes
Regression id: paired-launch-singleflight
Regression symptom: Two launchers can create independent agent pairs that write one worktree, and a losing failed starter may kill the winner's tmux session.
Regression guard: `loop-fork/tests/loop/launch-reservation.test.ts`, `loop-fork/tests/loop/tmux.test.ts`, and `evals/smoke/active-launch-interlock.sh`

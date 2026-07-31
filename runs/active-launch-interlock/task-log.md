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
- Hardened the first candidate after independent dissent: all valid run ids are
  scanned, stale-lock reclamation is guarded, cold resumes use replaceable
  attempt claims, resumed charters remain SHA-bound, missing Markdown paths
  stay invocation-cwd-bound, and a tmux race loser cannot terminalize a winner.
- Hardened the exact-SHA candidate after a second independent dissent reproduced
  stale lock takeover during a seven-second synchronous tmux scan: launch
  topology probes are now async and unbounded history scans yield so the
  `proper-lockfile` heartbeat remains live throughout the critical section.
- Added deterministic unit, process-contention, lifecycle, and tmux-race
  coverage plus an isolated compiled smoke with fake Gemini/Cursor TUIs, an
  isolated HOME, and a unique tmux socket.
- Focused verification passed (248 tests). The regenerated root verifier passed
  lint, typecheck, compiled build, 1,374 tests across 67 sorted files, and the
  empty named baseline allowlist. The hash-bound compiled smoke passed fresh
  contention, cold-resume contention, immutable claim/SHA preservation, and a
  distinct worktree using a 10,296-byte charter. Independent exact-SHA review
  CONCURred on `a93f7e4efcaa301b481db459baa63f8831902f5e` after reproducing
  one winner and one rejection across a seven-second critical section. That
  exact binary was atomically deployed with SHA-256
  `9aa496102c0d17d73381fa05543f4f34362bb2e144ba8197ff8eaf29c98e2f1b`;
  active run 108 was not restarted or mutated.

Regression: yes
Regression id: paired-launch-singleflight
Regression symptom: Two launchers can create independent agent pairs that write one worktree, and a losing failed starter may kill the winner's tmux session.
Regression guard: `loop-fork/tests/loop/launch-reservation.test.ts`, `loop-fork/tests/loop/tmux.test.ts`, and `evals/smoke/active-launch-interlock.sh`

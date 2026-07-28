# Pi command intake and lower-tier adoption run log

- 2026-07-27: Created isolated worktree from `codex/pi-sdk-integration` at
  `6ff9319`.
- 2026-07-27: Live Loop 56 proof showed Pi Nanny and Au Pair both wired, but
  only one completed job each. Historical classifier replay found 84 compound
  rejects and only one newly eligible command under the current grammar.
- 2026-07-27: Implemented mixed stage-scoped read/check plans, literal
  presentation filters enforced without a shell, bounded Git inspection
  additions, and registered-worktree propagation through every plan stage.
- 2026-07-27: Strengthened the shared Claude/Codex startup and channel
  guidance to submit one to three early packets, keep safe lower-tier work in
  flight, distinguish Nanny/Au Pair/Direct, and leave tier selection to
  Governess. Added `packets` and `plans` adoption counters to the board.
- 2026-07-27: Loop 56 replay recovered 18 previously skipped candidates in
  total, including five former compound rejects as structured plans, while 92
  cases remained fail-closed or actionable. Of the 18 recovered requests, 11
  select Nanny and seven exact deterministic requests select Direct. Replay
  output contains no command or prompt text.
- 2026-07-27: Focused suite passed 593/593 after correcting the Nanny endpoint
  in the linked-worktree fixture. Build and diff check passed. The first full
  suite exposed four stale default-model/service-tier assertions; those now
  match the existing `gpt-5.6-sol`/`standard` constants and their 29 focused
  tests pass.
- 2026-07-27: Final regression suite passed 1085/1085 across 54 files. Two
  independent local Qwen evaluations returned PASS: one over the complete
  diff and one over the final normalized Loop 56 replay.
- 2026-07-27: Installed the verified binary globally; `~/.local/bin/loop` now
  targets this worktree. Loop 56 had already exited (dead manifest PID and no
  tmux session), so there were no live lower-tier panes to hot-swap and no
  current Claude/Codex sessions to receive the guidance refresh.

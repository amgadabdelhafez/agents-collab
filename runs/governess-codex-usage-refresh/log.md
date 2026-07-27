# Governess Codex Usage Refresh — Run Log

- 2026-07-26: Live run 50 confirmed partial Codex row: hooks, quota, and bridge
  populated while transcript-backed fields were empty.
- 2026-07-26: Current manifest thread ID and per-run rollout matched; direct
  `readAgentUsage` parsing returned exact Codex usage.
- 2026-07-26: Respawned only `harvto-loop-50:0.2` with the existing binary.
  Codex transcript metrics populated immediately; Claude PID 27090, Codex PID
  27092, and worker PID 27542 were preserved. This confirmed a stale in-memory
  startup binding rather than missing telemetry or a renderer defect.
- 2026-07-26: Added manifest-binding refresh before each usage tick plus direct
  and run-loop regression coverage. Focused verification passed 80/80 tests.
- 2026-07-26: Full suite result was 827 pass / 4 fail; an independent evaluator
  reproduced the same four failures at base `d83f676` and found them unrelated.
  The 70-module build and `git diff --check` passed. `bun run check` could not
  run because the worktree dependency `ultracite` is unavailable.
- 2026-07-26: Independent evaluation returned PASS with no blocking findings.
- 2026-07-26: macOS rejected copied Bun executables with `load code signature
  error 2`; a fresh compile executed successfully and was deployed by preserving
  its inode with a same-volume rename. Temporary diagnostics were removed.
- 2026-07-26: Final clean runtime is live in `harvto-loop-50:0.2` at PID 44995.
  Claude PID 27090, Codex PID 27092, and worker PID 27542 remain unchanged.
  Codex shows `gpt-5.6-sol`, `xhi/std/1x`, `136k/258k 53% c1`, weekly `W8`,
  cost/rate, tokens, and activity. Governess doctor reports all checks true,
  journal healthy, and zero pending/dead-letter bridge controls.

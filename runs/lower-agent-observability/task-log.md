# Lower-Agent Observability Task Log

- 2026-07-26: Inspected live loop 46 without sending input or restarting panes.
  The utility tier had 10 routed jobs: 8 completed and 2 failed, totaling 19
  model calls, 12 bounded tool calls, 50,044 tokens, and $0.031600772478. The
  worker pane exposed only its latest compact status, and the governess board
  exposed no utility metrics.
- 2026-07-26: Created an isolated worktree and implementation spec. The design
  uses persisted utility journals as the sole read-only observability source and
  excludes raw provider traces and tool output from pane rendering.
- 2026-07-26: Implemented a shared, read-only utility observability snapshot,
  cumulative worker calls/tools/tokens/cost on both panes, a bounded
  request/tool/result transcript in the worker pane, and a dedicated LOWER row
  on the governess board. Removed the rendered Project / Objective / Progress /
  Next block while preserving persisted summary state and control behavior.
- 2026-07-26: Focused pane/runtime/governess suite passed 81/81. The broader
  utility/governess/bridge/tmux integration suite passed 340/340. The compiled
  binary builds, `git diff --check` passes, and `scripts/verify.sh` completes
  with its repository CONFIGURE placeholders.
- 2026-07-26: Full suite passed 772/776. The four failures reproduce unchanged
  in the canonical checkout and are the pre-existing stale Codex model/config
  expectations in `paired-options.test.ts` and `runner.test.ts`; no failure
  touches lower-agent observability.
- 2026-07-26: `bun run check` could not run because the worktree has no installed
  `ultracite` executable. Focused compilation/tests and the repository verify
  command remain the available proof.
- 2026-07-26: Previewed the new transcript against loop 46's real 58x20 lower
  pane without modifying the session. At that snapshot the worker had 16 jobs,
  12 completed, 4 failed, 27 model calls, 16 bounded tools, 63,491 tokens, and
  $0.041 cost. One failure exceeded the per-job token cap; three burst-routed
  jobs were never claimed and failed closed. The display makes those failures
  and their blockers visible but does not change scheduling policy.
- 2026-07-26: Independent evaluation initially found torn-tail history loss,
  upward-clamped tiny viewports, incomplete credential redaction, and whole-board
  governess overflow. Added an observability-only tolerant final-record reader
  while keeping routing fail-closed, exact viewport caps for both panes, common
  credential redaction, and compact whole-board prioritization with regressions.
  Final independent verdict is PASS in `eval.json`.
- 2026-07-26: Integrated feature commit `9e68c06` locally as merge `275677c`;
  nothing was pushed remotely. Rebuilt the canonical binary at the existing
  global target (`~/.local/bin/loop` resolves to the canonical checkout) and
  smoke-checked it. Installed SHA-256 is
  `168cc657927799c1bc183e66f11f491f7197ad8127122c5fdf4e123869574528`.
- 2026-07-26: Loop 46 was idle with no queued utility jobs, so only display panes
  were respawned. Lower-agent `%2` changed PID 22814 -> 96929 and governess `%3`
  changed PID 22816 -> 96931. Claude `%0` stayed PID 22447 and Codex `%1` stayed
  PID 22449. The live GLM pane now shows request/tool/response transcript and
  exact cumulative metrics; the governess pane shows the LOWER row and no
  Project / Objective / Progress / Next block. Governess state advanced to tick
  116 after refresh.

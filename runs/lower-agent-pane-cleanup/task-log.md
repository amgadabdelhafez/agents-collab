# Lower-Agent Pane Cleanup Task Log

- 2026-07-26: Inspected loop 46 at 58x20 utility and 176x20 governess geometry.
  The AGENT bridge cell and local-LLM batch cell wrapped onto extra lines, the
  standalone LOWER table duplicated table structure, and utility responses were
  dominated by generic outcome/path boilerplate before useful evidence appeared.
- 2026-07-26: Created an isolated cleanup worktree and spec. Scope is display and
  read-only observability only; routing/scheduling behavior remains unchanged.
- 2026-07-26: User confirmed the four-pane geometry and proportions in the live
  screenshot are exact and must remain unchanged. Only bottom-pane content and
  in-pane column/layout rendering may change.
- 2026-07-26: Implemented one shared 172-column AGENT table (Claude, Codex,
  utility), a 176-column local-LLM table, and Progress/Next-only summary footer.
  Utility activity now groups complete jobs and attaches duration, model/tool
  calls, tokens, cost, and evidence-first results. A compact 58x10 job card is
  covered for temporarily short panes; the full 58x20 view shows two recent
  jobs in 19 rows with no line wider than 58.
- 2026-07-26: Focused utility/governess verification passed 82/82; compiled
  build and `git diff --check` passed. Full suite passed 773 tests with the same
  four unrelated Codex default-model/launcher expectation baselines. The root
  `scripts/verify.sh` completed but still contains configured-placeholder
  sections for lint, typecheck, unit, and integration commands.
- 2026-07-26: Loop 47 initially acquired two extra Claude subagent panes in its
  main window. At the user's request, moved both live subagents without restart
  into a separate `loop47-agents` window and restored the main window to exact
  118x30 Claude, 116x30 Codex, 176x20 governess, and 58x20 utility geometry.
- 2026-07-26: Independent evaluation initially caught two display correctness
  defects: a torn jobs-journal tail could throw from the route-status row, and
  aggregate counts could label a latest failed job as done. Switched route
  detail/state to the observability-safe journal snapshot and added regressions
  for torn-tail rendering and mixed completed/latest-failed history.
- 2026-07-26: Independent re-evaluation passed. Final evidence: focused 82/82,
  broad 341/341, full 773 pass plus the same four canonical baseline failures,
  build/diff checks pass, no tmux/layout implementation diff, 172-column AGENT
  table, <=176-column LLM table, and safe 58x20/58x10 worker output.
- 2026-07-26: First live loop 47 refresh confirmed the new utility transcript,
  unified AGENT row, LLM row, and Progress/Next footer. The status line alone
  wrapped because it rendered zero-only governess message counts; suppressed
  that non-signal segment while preserving nonzero counts.
- 2026-07-26: The next live capture found only the paired `bridge latest` line
  wrapping. Reduced each message/action excerpt from 64 to 54 characters and
  tightened its regression limit from 180 to 176 visible columns.

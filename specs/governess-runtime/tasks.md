# Tasks: Governess Runtime

- [x] Rename source files, symbols, CLI flags, env vars, state/log files, board
      copy, docs and tests to governess.
- [x] Isolate legacy aliases and state-file migration.
- [x] Implement lifecycle protocol and runtime adapter.
- [x] Implement durable control journal and idempotent delivery phases.
- [x] Implement fencing epoch and driver lease.
- [x] Implement deterministic action-policy gate.
- [x] Integrate tiered observation/decision/execution boundaries.
- [x] Implement handoff bundle/ready/replacement acknowledgement protocol.
- [x] Close each drained agent TUI exactly once after bundle validation.
- [x] Launch replacements from a persisted continuation Markdown file without
      re-entering planning preflight.
- [x] Deliver confirmed drain controls directly only after turn-end evidence,
      so the request starts an agent turn instead of merely entering bridge history.
- [x] Implement replay and doctor commands.
- [x] Add focused and migration regressions.
- [x] Build, run full tests, evaluate and deploy narrowly.
- [x] Replace duplicate runtime/activity rows with one unified agent row.
- [x] Add unified-table layout, width and field-grouping regressions.
- [x] Rebuild and narrowly refresh the live governess pane.

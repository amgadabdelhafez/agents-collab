# Tasks: tmux redraw backpressure

- [x] Map synchronous tmux calls in one Governess cycle and document which are
      observation-only versus control mutations.
- [x] Implement a tick-scoped tmux outage circuit and persisted degraded-display
      state.
- [x] Continue durable board rendering while pane evidence is unavailable.
- [x] Fail closed for recovery, nudge, delivery, role, and liveness decisions
      that require current pane evidence.
- [x] Add focused stalled-control, recovery, probe-count, and large-output tests.
- [x] Run focused tests, full loop tests, build, and `git diff --check`.
- [ ] Write `runs/tmux-redraw-backpressure/eval.json` and task log.
- [ ] Request independent exact-SHA review before deployment.

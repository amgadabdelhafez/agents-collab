# Babysitter exit control task log

## 2026-07-25

- Added `x`-opened exit menu with explicit `e`, `h`, and cancel controls.
- Added persisted graceful-handover state and raw single-key input.
- Handover requests wait for idle-safe agent states and are delivered once per agent.
- Replacement launch waits until both agent TUI processes have exited.
- The old tmux session is stopped only after replacement launch succeeds; launch failure remains retryable.
- Focused tests: 59 passed, 0 failed with `LOOP_BABYSIT_LIMIT_HANDOFF=1`.
- Full tests: 575 passed, 4 pre-existing Codex model/runner expectation failures.
- Build: passed with `bun run build`.
- Independent review found and prompted fail-closed pane probing, live replacement verification on restart, persisted launch completion, pre-delivery notification persistence, and lifecycle ordering tests.
- Repository verify wrapper: completed; its lint/typecheck/test commands remain placeholders.
- Live `harvto-loop-33`: replaced only babysitter pane; Claude PID 38930 and Codex PID 38932 were unchanged. `x` showed the menu and `c` restored the board. No handover or teardown action was exercised.

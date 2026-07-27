# Utility worker pool task log

- Added a default two-slot worker pool, configurable from one through eight.
- Excess utility-eligible jobs remain `pending-route`, so claim timeout begins
  only after a slot exists and the worker is spawned.
- Non-utility decisions continue to route while slots are full.
- Focused utility tests: 36 passed; full suite: 802 passed with the same four
  pre-existing Codex-launch expectation failures; build and diff check passed.
- Deployed by respawning only governess pane `%3`; Claude PID 17372, Codex PID
  17374, and worker-pane PID 17719 were preserved.

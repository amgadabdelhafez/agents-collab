# Decisions

- `x` is reversible and has no lifecycle side effects.
- `e` is available only in the open menu or as an explicit force-teardown during handover.
- There is no automatic destructive timeout during graceful handover.
- Agent requests are delayed while their state is working, thinking, limited, crashed, or stuck.
- A replacement starts with the same primary/peer pairing and an explicit continuation prompt.
- Replacement launch is transactional: failure preserves the old babysitter and exposes retry/teardown controls.
- Unknown, malformed, wrapper, and failed pane-process probes remain waiting; only a dead pane or recognized shell proves an agent exited.
- A successful replacement session is persisted before the old run is marked stopped and its tmux session is killed; a restarted babysitter reuses that result instead of relaunching.
- Handover notification intent is persisted before delivery so a babysitter crash cannot repeat direct composer injection.
- This notification ordering is deliberately at-most-once: a crash in the narrow save-before-send window can leave handover waiting, but cannot duplicate text in an agent composer or trigger destructive behavior; `e` remains available for explicit teardown.
- On babysitter restart, a persisted replacement must name a currently live tmux session before the old loop can be stopped.
- Recovery, role balancing, agent rename, and new background label/summary work are suppressed while exit/handover control is active.
- Live verification is limited to `x` and cancel so active user work is never interrupted by a test.

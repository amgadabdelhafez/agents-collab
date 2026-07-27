# Live runtime acceptance

Run: `harvto-loop-53`
Run directory: `/Users/amgad/.loop/runs/harvto-b1e274e66299/53`

## Before

- Default utility capacity: 2.
- Two long-running workers occupied both slots.
- Seven eligible jobs remained `pending-route`.
- Claude PID: 14054.
- Codex PID: 14056.
- Governess PID: 14466.
- Worker display pane PID: 14468.

## Deployment

- Set `LOOP_UTILITY_MAX_CONCURRENCY=4` for tmux session
  `harvto-loop-53`.
- Respawned only pane `%2`, the governess pane.
- New governess PID: 70163.
- New governess epoch: 1785166861517163.
- The prior two stale workers were epoch-fenced and failed closed.

## Acceptance

- Four simultaneous utility-worker processes were observed under governess PID
  70163 at 2026-07-27T15:45:47Z.
- Completed utility jobs increased from 2 to 14.
- The pending-route backlog fell from 7 to 0 before newer work arrived.
- Claude PID 14054, Codex PID 14056, both Claude subagent panes, and worker
  display PID 14468 were preserved.
- `loop governess doctor 53` remained green across all checks.
- Bridge dead letters and expired messages remained zero.

## Installed default

- Candidate SHA-256:
  `91f1a7a09484e6dee0c5d443dccf21b45b702686be88d80ac4198542f9b95a9a`.
- The canonical binary and `/Users/amgad/.local/bin/loop` resolve to the same
  SHA-256.
- Installed help reports
  `LOOP_UTILITY_MAX_CONCURRENCY=<1..8>` with `default: 4`.
- The active governess was not restarted a second time, avoiding unnecessary
  fencing of four in-flight jobs; its live session override is already 4.

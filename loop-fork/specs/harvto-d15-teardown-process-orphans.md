# harvto-d15-teardown-process-orphans

Task completed 2026-08-16T06:56:26Z, mode emergent.

## What was built

- Added exact launcher and main-agent ownership records, identity-revalidated bounded TERM/KILL,
  zombie-aware settlement, self/ancestor protection, deferred exact-self-launcher cleanup, and
  durable unresolved evidence.
- Made Governess lifecycle success depend on settled run-owned processes and direct death of the
  exact manifest-recorded tmux socket/session.
- Preserved exact-base red and added positive, negative, replay, fail-closed, PID-reuse, zombie,
  registration-failure, exact-socket, and fixture-isolation controls.

## Decisions made

- Process settlement accepts exact PID absence or `Z`/defunct state; bare `kill(pid, 0)` is not
  sufficient.
- Main-agent registration excludes `native-child`, and process identity binds exact command plus
  one-second-granularity `lstart`.
- Exact self-launcher cleanup may transfer only after a durable versioned receipt; other self or
  ancestor ownership fails closed.

## Open items at completion

- None for D15. D6 remains a separate task.

## Trajectory

- 001 - initial (2026-08-16T03:56:29Z)
- 002 - promoted parked idea (2026-08-16T03:56:30Z)
- Exact-base red preserved at base `fb71f47bb126a39eae7f1613fa952c994421de5e`.
- Implementation committed as `5f5ddba66cdb1bc5d8f6212b763323f507b0b777` and approved by Claude
  exact-SHA verdict `b5280c18-08cc-439c-8009-9d121ea1dfe8`.
- Harness closed exactly once at 2026-08-16T06:56:26Z with eval `pass`.

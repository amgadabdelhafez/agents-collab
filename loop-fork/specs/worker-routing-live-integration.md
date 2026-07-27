# worker-routing-live-integration

Task completed 2026-07-27T06:16:15Z, mode planned.

## What was built

- Created the task worktree from current `main` (`39e479b`) and wrote the
  integration spec before touching runtime source.
- Ported the three previously verified governess fixes exactly onto current
  main: live session rebinding, transient pricing retention, and per-provider
  quota snapshot retention.
- Added execution-profile tool restriction, bounded literal Git metadata
  inspection, and a 1 MiB input-file ceiling with the 64 KiB result ceiling
  preserved for both reads and search.
- Deployed the independently evaluated build to run 51 without restarting
  Claude or Codex. Live Git and large-read canaries completed, and the worker
  served six routed jobs.

## Decisions made

- Do not raise worker concurrency to mask broker-unsatisfiable tasks. First
  ensure every auto-routed request has an exact broker execution profile.
- Preserve `undefined` only for intentional explicit requests; malformed
  persisted execution profiles fail closed to zero tools.

## Open items at completion

- The repository-wide static-check and four full-suite Codex app/config
  failures remain baseline infrastructure debt; neither regressed in this
  task.

## Trajectory

- 001 - initial (2026-07-27T05:39:27Z)
- 002 - spec complete; stale deployed binary identified (2026-07-27T05:40:50Z)

# constant-size-transport

Task completed 2026-07-29T18:17:40Z, mode planned.

## What was built

- Created the root feature spec, implementation plan, bounded task list, and
  acceptance contract before runtime edits.
- Initialized the Harness v2 task and mirrored the release gates into its plan.
- Persisted complete, per-agent launch charters below each run directory with
  byte length and SHA-256 bindings in the manifest. Launch panes receive only a
  sub-1-KiB verification bootstrap. Directories are forced to `0700` and the
  charter/bootstrap files to `0600` even when an existing path is overwritten.
- Removed full-body bridge delivery from the Codex tmux proxy. Codex now uses
  app-server delivery independent of tmux, resumes evicted threads, and keeps
  the bridge message pending unless the app server accepts the turn.
- Added claim-safe concurrent delivery, unresolved notification events, a
  30-second unchanged-inbox throttle, and terminal nudges below 128 bytes. The
  bridge ledger remains the only full-body transport and durable truth.
- Updated agent guidance so a terminal nudge triggers `receive_messages` and is
  never interpreted as the message body.
- Added realistic 10,257-byte launch coverage, manifest/hash/mode assertions,
  evicted-thread recovery and failure cases, concurrent-claim and notification
  races, and a regression proving the tmux proxy cannot submit bridge bodies.
- Recorded 278 focused tests with Harness, then passed lint, source typecheck,
  compiled build, the full sequential repository suite, and an empty baseline.
- RULING 26 released the T4/census gate with independently matching ZERO-ADMIT
  derivations. At that point, deployment remained held only for exact-SHA
  review of the cumulative change.
- Claude independently verified 1,214 tests, the candidate binary hash, the
  pointer bootstrap, and the bounded tmux control plane, then issued DISSENT on
  exact commit `e14773a6c013c9ccaefd936d3b08d63ed055d5e0` because both committed
  transport smoke scripts encoded the retired full-paste behavior and failed.
- Replaced those guards with a live hash-verifying fake TUI. The launch guard
  now verifies both agents against their run-owned charter hashes, checks
  bootstrap size/body isolation and file modes, deliberately tampers one
  charter to prove fail-closed behavior, and preserves named-session, pane,
  manifest, and nonzero missing-workspace assertions.
- The runtime guard now discovers panes from manifest agent ownership, sends a
  9,279-byte sentinel body, proves the pane received exactly one 53-byte nudge
  with no body or subject, proves notification did not resolve the message,
  then drains the complete body through `receive_messages` with exactly one
  delivered resolution.
- The combined committed smoke passed twice under Harness. The full repository
  verifier then passed lint, source typecheck, compiled build, the sequential
  test suite, and the empty baseline allowlist on the final review tree.
- Claude issued exact-SHA CONCUR `c6e8ba46-6155-4532-8d74-2dc7689014a1`
  for `3542760d26608fdf5574405a9e9779a1ad727de9` after independently running
  both committed guards and all 1,214 tests. The reviewed binary was deployed
  at SHA-256 `66daf24713dc3e5e8e08387b3bd8202772be5d988e092ee7df5bc52ffec016f9`.
- The first production pointer-bootstrap launch, Harvto run 100 / loop-64,
  passed the joint QA gate and started on the reviewed binary with both agent
  panes alive and no manual intervention.

## Decisions made

- Persist complete composed launch charters inside the run directory and bind
  them by path, byte count, and SHA-256 in the manifest.
- Keep launch bootstraps below 1 KiB and fail closed on a hash mismatch.
- Deliver Codex bridge messages through app-server without a tmux dependency.
- Notify interactive non-Codex panes with a constant-size nudge; agents pull
  bodies from `receive_messages` and only that pull resolves delivery.
- Hold deployment for exact-SHA review plus the T4/census release.

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-29T16:40:57Z)
- 002 - constant-size transport specification and release gates (2026-07-29T16:52:36Z)
- 003 - constant-size charter and bridge transport implemented (2026-07-29T17:10:00Z)
- 004 - final constant-size transport candidate; RULING 26 release gate passed (2026-07-29T17:16:03Z)
- 005 - committed constant-size smoke guards repaired after exact-SHA dissent (2026-07-29T18:02:25Z)

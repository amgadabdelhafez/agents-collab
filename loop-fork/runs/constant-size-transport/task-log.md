# Task constant-size-transport

Created: 2026-07-29T16:40:57Z
Mode: planned
Description: Replace large inline launch charters and terminal message bodies with hash-bound pointer bootstraps plus bridge-owned constant-size delivery.

## What I changed

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
  derivations. Deployment remains held only for exact-SHA review of this
  cumulative change.
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

## Why

- Realistic charters and bridge bodies must not be transported through terminal
  paste paths whose correctness varies with size or tmux responsiveness.
- Full content remains durable and inspectable; the terminal carries only a
  hash-bound launch pointer or a constant-size inbox notification.

## Notes

- Live run 99 is read-only and remains on the previously deployed binary.
- Deployment is held for exact-SHA review; RULING 26 released the T4/census
  disposition.
- The superseding bounded-tmux candidate is commit
  `60213161996e1884e72eaa59e6805db09a9028eb`; its independent review is still
  pending.

Regression: yes
Regression id: terminal-payload-size-coupling
Regression symptom: Realistic launch charters and bridge bodies could block or silently fail when transported through terminal paste and tmux readiness paths.
Regression guard: `bun test tests/loop/tmux.test.ts tests/loop/bridge.test.ts tests/loop/codex-app-server.test.ts tests/loop/codex-tmux-proxy.test.ts`

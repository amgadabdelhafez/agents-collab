# Task cross-repo-stale-bridge-sweep

Created: 2026-07-29T18:55:09Z
Mode: planned
Description: Safely reap exact stale bridge MCP children across all stored repositories

## What I changed

- Added the root spec, plan, tasks, and verification contract.
- Inspected the current-repository abandoned-run GC, CLI startup ordering, and
  live macOS process shapes.
- Added `stale-bridge-cleanup.ts` as an isolated startup maintenance path. It
  enumerates only exact `loop` executables, accepts only the direct
  `__bridge-mcp` argv shape, requires a canonical two-level run directory, and
  signals only for a strict terminal manifest or an affirmatively absent run.
- Rechecks run state and then rereads the exact PID executable and command
  immediately before `SIGTERM`; changed, unreadable, or active evidence spares.
- Wired the sweep after the immediate helper/version/help bypass and before the
  current-repository abandoned-run GC.
- Added adversarial and CLI ordering tests.

## Why

The current cleanup scans only one repo ID and its command ownership check is
substring-based. Long-lived desktop sessions can retain direct old bridge
children for dead runs, while their parent app-server argv can embed the same
bridge text. The replacement must use exact identity and fail closed.

## Notes

Regression: yes
Regression id: cross-repo-stale-bridge-wedge
Regression symptom: Old bridge MCP children can issue unbounded tmux probes and wedge new launches.
Regression guard: tests/loop/run-process-cleanup.test.ts and tests/loop.test.ts

Live run 100 is read-only. No process was signaled during investigation.

## Verification

- Harness focused verification: 32 passed, 0 failed.
- Lint: passed.
- Defined source typecheck: passed.
- Compiled binary build: passed.
- Full sequential repository test suite: every test file passed, 0 failed.
- Live no-signal dry run: 11 loop executables scanned; the three exact bridge
  candidates all belonged to active run 100 and were preserved.
- A broad repository `tsc --noEmit` command outside the defined verifier still
  reports the pre-existing test/source typing debt; the required source-only
  verifier command passes and this candidate adds no reported TypeScript error.
- Claude independently reviewed exact SHA
  `8e89909bb76b5b7b26d4d87c3317b017e2546d4a`, reran 1,223 tests with zero
  failures, matched binary SHA-256
  `23990085b21dbf7572a336346fbb8e4db083aabf32bcc65d72083299fa0282b3`,
  and issued CONCUR in message `a77e0762-28ab-41b9-8985-e60d9d245956`.
- Deployed the reviewed binary through `/Users/amgad/.local/bin/loop`.
- Supervised production sweep scanned 11 loop executables, preserved both
  exact active run-100 bridge candidates (PIDs 79992 and 80024), signaled zero,
  and left `harvto-loop-100` plus the standing liaison channel available.

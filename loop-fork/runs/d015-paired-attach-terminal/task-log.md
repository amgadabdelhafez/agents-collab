# Task d015-paired-attach-terminal

Created: 2026-08-09T18:06:14Z
Mode: planned
Description: Treat tmux foreground attach capability failure as a non-fatal warning after a healthy detached paired launch, with exact socket-aware recovery guidance.

## What I changed

- Preserved the exact paired tmux socket through launch and liveness checks.
- Made a foreground attach exception non-fatal only after the exact detached
  session is independently confirmed live.
- Added an exact socket-aware manual attach command to the warning.
- Added regression coverage for the observed terminal capability error while
  preserving vanished-session, unknown-liveness, and launch-failure behavior.

## Why

The initiating terminal can reject tmux's clear operation after the paired
session has already started successfully. That attach-only capability failure
must not turn a healthy detached run into a failed launch or invite a duplicate
retry.

## Notes

Regression: yes
Regression id: paired-attach-terminal-capability
Regression symptom: A healthy detached paired run is reported as failed when
the initiating terminal cannot clear for tmux attach.
Regression guard: `tests/loop/tmux.test.ts` focused attach-failure cases.

Base: local `main` at `bf2246f38658356bd62cd569e1abf48614cada63`, the
exact v1.0.38 release source. `origin/main` is an ancestor but remains at the
older v1.0.33 lineage, so using it would not test the installed runtime path.

Verification:

- focused `tests/loop/tmux.test.ts`: 106 pass, 0 fail
- scoped Ultracite static check: pass
- compiled build: pass, 3,054 modules
- full `test:ci`: one named pre-existing failure only,
  `tests/release-packaging.test.ts`, which expects `1.0.35` while the base
  package is `1.0.38`; neither file is changed by this task
- parked follow-up: `d016-release-packaging-version-drift`
- separate zero-write review: `PASS` after correcting the cold-launch socket
  propagation path; reviewer confirmed exact socket use for every post-start
  probe, attach, recovery guidance, and final transport-release gate

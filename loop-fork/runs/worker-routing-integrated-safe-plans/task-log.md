# Task worker-routing-integrated-safe-plans

Created: 2026-07-27T17:07:22Z
Mode: planned
Description: Integrate broader worker tools, four slots, runaway guards, structured read-only compound routing, and actionable skip telemetry

## Live evidence before implementation

- First 351 skipped observations: 189 tool-not-enforceable, 95 compound/unsafe,
  25 workspace-unverified, and 42 other bounded-policy reasons.
- Compound audit: 59 read-only chains, 20 mutation/remote-authority commands,
  13 dynamic interpreter/process commands, and 3 focused tests.
- Active governess executable inode differs from the installed executable; the
  in-memory classifier and newly spawned worker broker are on separate builds.

## Notes

Regression: yes
Regression id: integrated-worker-routing-contract
Regression symptom: Live classifier and spawned workers can expose different tool profiles, while safe compound reads remain with the primary agent.
Regression guard: tests/loop/delegation-policy.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-observability.test.ts

## What I changed

- Integrated broader broker tools, contention-safe claims, four worker slots,
  and all three runaway circuit breakers into one branch.
- Added a two-to-six-stage read-only plan classifier with a twelve-scope cap.
- Added bounded cat, empty-pattern line read, multi-directory list, and linked
  worktree leading-cd mappings.
- Added actionable-miss, intentional-retain, and unsafe-reject telemetry with
  legacy inference and terminal-board rendering.
- Replaced the broad read-plan broker with an ordered per-stage broker. Each
  stage exposes exactly one tool and its own scopes, exact read boundary, and
  output filter; completion fails while any stage remains unexecuted.

## Why

The active classifier and installed worker broker were on different builds,
and the former skipped-command total mixed fixable routing gaps with deliberate
authority boundaries. One coherent release fixes both the runtime mismatch and
the misleading operator signal.

## Notes

- The read-plan profile has no fixed tool set. The runtime exposes exactly the
  current stage's single read-only tool and advances only on success.
- Final focused verification: 435 passed, 0 failed across nine boundary
  suites. The full suite is at exact baseline parity (1,024 pass / 4 unrelated
  Codex-launch expectation failures). Independent review passes. Live loop-53
  restart/layout verification is unavailable because its tmux server exited.

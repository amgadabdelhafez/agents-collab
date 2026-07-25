# Task governess-native-runtime

Created: 2026-07-25T21:49:56Z
Mode: planned
Description: Complete the remaining OSS-inspired governess runtime architecture: structured adapters and lifecycle events, acknowledged controls, semantic handover acceptance, phased supervision, behavioral replay/explain, and dynamic judge layout.

## What I changed

- Created a spec-first implementation slice for structured runtime events,
  acknowledged controls, semantic handover, replay/explain, and compact layout.
- Recorded the OSS pattern review and chose adaptation over new dependencies.
- Added agent-hook lifecycle IDs/sequences/states and made hook evidence
  authoritative over terminal-derived fallback state.
- Routed Claude through its channel and Codex through its app-server/bridge;
  terminal input is now a guarded fallback with a last-moment draft check.
- Added monotonic control phases, post-dispatch hook reconciliation, safe-only
  retries, policy inputs, transport/evidence receipts, behavioral replay, and
  `governess explain`.
- Split each runtime tick into an immutable observation snapshot, pure decision
  function, and fenced executor.
- Added digest-bound handover manifests and replacement-loop acceptance before
  old-loop teardown.
- Added dynamic judge-row budgeting for small panes.
- Bounded behavioral cycle snapshots to only the hook evidence that caused a
  transition; a live run exposed and verified the fix for unbounded records.

## Why

The existing durable journal and fencing are sound foundations, but delivery
receipts and lifecycle evidence are not yet authoritative enough to prevent
ambiguous retry behavior or support behavioral replay.

## Notes

Regression: yes
Regression id: governess-repeated-composer-control
Regression symptom: A repeated governess rename/control can remain in the shared composer and consume later Claude or user input.
## Verification

- Focused governess suite: 87 passed, 0 failed.
- Full repository suite: 598 passed, 4 failed. All four failures are the known
  unrelated Codex default-model/mock expectation baseline in
  `paired-options.test.ts` and `runner.test.ts`.
- `bun run build`: pass.
- `git diff --check`: pass.
- Live `harvto-loop-34` refresh and installed-binary rollout: governess PID
  changed `96360 -> 74573 -> 77535 -> 79942`; Claude PID `10483` and Codex PID
  `10485` were preserved. Both
  pre-existing composer lines were unchanged, the board remained healthy, and
  compact replay records were 1,077-1,078 bytes with no irrelevant hook arrays.
- Installed-binary doctor passed all 11 checks; behavioral replay passed with
  60 checks, 973 journaled controls, and no issues.
- Semantic handover acceptance is covered in isolated tests; it was not invoked
  against the productive Harvto loop because that intentionally exits agents.
- `bun run check`: repository-wide baseline does not pass because Ultracite
  reports pre-existing formatting/lint debt across historical run artifacts and
  unrelated source files; changed standalone modules pass targeted checks.

Regression guard: tests/loop/governess-runtime.test.ts, tests/loop/governess-exit.test.ts, tests/loop/governess-hooks.test.ts, and tests/loop/governess.test.ts

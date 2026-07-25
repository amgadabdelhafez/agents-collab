# Task log: governess-runtime

## Scope

- Canonically rename the paired-loop supervisor to governess.
- Preserve old inputs only through one compatibility boundary.
- Retain the rename-injection and board-layout fixes.
- Add explicit exit/handover lifecycle controls and SOTA-inspired runtime safety.

## Implementation

- Renamed source, test, type, CLI, environment, manifest, pane, state, log and
  documentation surfaces to governess.
- Added legacy input/state migration in `legacy-governess-compat.ts` only.
- Added explicit runtime lifecycle states and an adapter contract.
- Added epoch fencing, atomic state writes and a renewable driver lease.
- Added policy tiers that forbid repository mutations and require confirmation
  for restarts, teardown and handover.
- Added a durable idempotent JSONL control journal with replay validation.
- Added two-phase JSON handoff bundles and replacement-session readiness checks.
- Added a 250 ms direct-control submit settle window so long Codex prompts are
  submitted as turns instead of remaining in the composer.
- Restricted direct input to completed `Stop` hooks; notification and permission
  prompts now fail closed rather than consuming injected controls.
- Added epoch-gated, at-most-once `/exit` submission after each valid bundle and
  persisted a Markdown continuation prompt for replacement launches.
- Added `loop governess doctor` and `loop governess replay`.
- Replaced the duplicate runtime and activity tables with one unified header and
  exactly one compact row per agent. Composite cells group run mode, context /
  compactions, limits / reset countdowns, spend / hourly burn, token splits,
  activity totals and bridge traffic.

## Verification

- Focused: 198 passed, 0 failed; final exit/runtime slice: 72 passed, 0 failed.
- Full: 591 passed, 4 failed. The four failures are the pre-existing Codex model
  and bridge-config expectation drift in `paired-options.test.ts` and
  `runner.test.ts`; no governess tests failed.
- Build: passed.
- `git diff --check`: passed.
- `ultracite check` passed for the new exit controller and its tests.
- Static canonical-name scan: no old spelling outside the isolated compatibility
  module; immutable historical run/eval artifacts retain their original names.

## Evaluation and deployment

- Independent evaluator: PASS after three passes. Initial fail-open findings for
  uncertain rename state, missing readiness, malformed journal, missing fence /
  lease, unacknowledged controls and unreconstructable probes were fixed and
  regression-tested.
- Narrow live deployment: respawned only `harvto-loop-34:0.2` from the isolated
  verified binary. Claude/Codex PIDs remained `10483` / `10485`.
- Live state migrated at tick 124 and the refreshed layout advanced through tick
  170 under driver-lease epoch `1785011277066881`.
- `x` opened the menu and `c` canceled it; destructive `e` / `h` were not used.
- Live doctor: all 11 checks true. Final journal replay: 104 controls, 0 issues.
- Live manifest now persists canonical `governess` and `tmuxPaneGoverness` keys.
- The unified live header is 175 visible characters and both agent rows are 179,
  below the 180-column ceiling with no clipped composite value.
- Disposable run 8 completed the full `x` then `h` protocol: both drain prompts
  produced `UserPromptSubmit`, both epoch-matching bundles validated, Codex and
  Claude exited once, replacement loop 9 reached three live panes, and only then
  loop 8 recorded `handover-launched`, marked itself stopped and exited.
- Replacement loop 9 was explicitly torn down after verification; no disposable
  agent session remains running.

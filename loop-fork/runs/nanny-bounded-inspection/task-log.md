# Task nanny-bounded-inspection

Created: 2026-07-27T22:52:44Z
Mode: planned
Description: Broaden Nanny routing to safe unprofiled bounded read-only inspections while preserving Direct, Au Pair, and primary-agent boundaries

## What I changed

- Started a dedicated Harness task and corrective spec.
- Recorded the live gap: post-swap Nanny utility jobs were zero while Direct
  handled exact operations and Au Pair received unprofiled inspection work.
- Added a narrow classifier predicate for unprofiled low-risk inspections with
  one or two read scopes, at most two context refs, one to four acceptance
  criteria, no authority/write surface, and at most 6,000 objective+criteria
  characters.
- Preserved Direct priority, profiled Nanny behavior, and Au Pair ownership of
  commands, edits, reviews, focused verification, broader scopes, and legacy
  `utility-default` jobs.
- Added classifier and runtime regressions, including Nanny-slot queueing and
  no fallback to Au Pair when Nanny is unavailable.
- Recorded 49 passing focused routing/runtime tests, a successful compiled
  build, and a clean diff check.
- Hot-swapped only Loop 56 governess and proved live job
  `69768c20-a361-4a46-8c9a-f12e5b7fa527` completed through Nanny/Pi SDK with
  one broker read, zero cost, and no Au Pair spill.

## Why

The existing classifier requires an execution profile for Nanny, leaving safe
unprofiled bounded inspections in the Au Pair band.

## Notes

Regression: yes
Regression id: nanny-empty-inspection-band
Regression symptom: Nanny shows advisory calls but receives zero utility jobs.
Regression guard: tests/loop/utility-execution-tier.test.ts

## Verification debt outside this slice

- `bun run test:ci` reaches an existing `paired-options.test.ts` assertion that
  expects `gpt-5.5/fast` while the current branch writes
  `gpt-5.6-sol/standard`.
- Repository-wide `ultracite check` reports historical formatting debt under
  existing `runs/` artifacts and pre-existing lint debt in the large runtime
  files. The two classifier files modified for this slice pass targeted
  Ultracite checks.

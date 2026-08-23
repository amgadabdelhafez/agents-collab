# Task webui-theme-mode

Created: 2026-08-23T05:28:47Z
Mode: planned
Description: Add persistent dark, light, and follow-system appearance modes to the Web UI.

## What I changed

- Added a typed Appearance mode with exact `system`, `light`, and `dark`
  values, safe browser persistence, document metadata synchronization, and live
  `prefers-color-scheme` observation.
- Added a labelled global Appearance control that remains visible and contained
  at the 390 by 844 mobile viewport.
- Tokenized dark-only neutral surfaces and added a complete light palette while
  preserving the existing status hierarchy.
- Applied the stored or system-resolved theme before React renders.

## Why

The control surface currently forces the dark palette. Operators need a local
preference that can also stay aligned with the operating system.

## Notes

- Base: GitHub `main` at merge commit
  `2848c91e96d1d1d57a1b0b87caea54adc6d134a6`.
- Forgejo `origin/main` remains at the pre-Web-UI base, so this task branches
  from the actual merged GitHub main.
- Focused theme tests: 6 tests, 21 assertions, zero failures.
- Render contract: 5 tests, 54 assertions, zero failures.
- Browser evidence covers desktop Light and Dark, persistence after reload,
  system resolution, exact mobile containment, and a clean console against one
  live Harvto lane.
- Full sequential regression passed 1,652 tests across all 81 discovered
  `.test.ts` files with zero failures. The focused render contract separately
  covers the repository's `.test.tsx` UI suite.
- Targeted formatter, lint, and type checks pass for all changed source/test
  files. The mandated top-level `scripts/verify.sh` was run and stops at its
  repository-wide lint step on 81 pre-existing formatting diagnostics in
  generated Harness JSON from completed Web UI tasks; it reports no changed
  source/test diagnostic before stopping.

# webui-readonly-mvp-direct

Task completed 2026-08-21T05:50:44Z, mode planned.

## What was built

- Added a runnable React 19, TypeScript, and Vite browser app under
  `src/webui/`, with local development and production build scripts.
- Added versioned read-only DTOs, six deterministic synthetic/redacted fleet
  scenarios, detailed run fixtures, and pure grouping/filtering/sorting
  selectors.
- Built the Fleet view with the four canonical exclusive groups, search,
  repository/state filters, read-only terminal guidance, adapter/provenance
  disclosure, and explicit fixture/demo labeling.
- Built the Run workspace with a persistent authority summary, both frontier
  seats, session and weekly quotas, diagnostic tabs, Governess facts and policy,
  bounded Direct/Nanny/Au Pair activity, timeline, and evidence dialog.
- Added responsive layouts, 390px no-overflow behavior, keyboard tab navigation,
  evidence focus trapping/restoration, Escape dismissal, reduced-motion support,
  and text/shape status cues.
- Added focused selector and server-rendered contract tests plus desktop and
  narrow browser evidence.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-21T05:11:05Z)
- 002 - Direct Web UI scope frozen: React TypeScript Vite, typed fixture adapter, fleet plus run workspace, no runtime mutation or Loop precursor work. (2026-08-21T05:12:53Z)

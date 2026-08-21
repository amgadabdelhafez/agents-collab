# Task webui-readonly-mvp-direct

Created: 2026-08-21T05:11:05Z
Mode: planned
Description: Build the runnable read-only Loop Web UI fleet and run workspace directly from the reviewed control-surface specification

## What I changed

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

## Why

The existing work had a reviewed control-plane specification but no visible Web
UI implementation. This slice makes the product directly reviewable now while
keeping the mutation boundary closed and preserving a typed seam for the future
live read-only HTTP/SSE adapter.

## Notes

- The app is deliberately backed by synthetic, fully redacted fixtures. The
  Fleet and Run screens label that fact persistently and do not claim a live
  runtime connection.
- No Loop CLI, provider, tmux, bridge, Governess, manifest, or lifecycle behavior
  changed.
- Run locally with `bun run web:dev` and open `http://127.0.0.1:46327/`.
- Production assets build to the ignored `dist/webui/` directory.

## Verification

- `bun run web:build`: pass, strict TypeScript plus Vite production bundle.
- `bun run test:file -- tests/webui/selectors.test.ts tests/webui/render.test.tsx`:
  5 tests, 39 assertions, pass.
- `bun run build`: pass for the existing compiled Loop CLI bundle.
- `bun run test:ci`: pass in the native host environment.
- `bunx biome check src/webui tests/webui vite.webui.config.ts`: pass.
- `git diff --check`: pass.
- Browser checks at 1280x720 and 390x844: zero console errors, four visible
  quota cards, no page-level horizontal overflow, and the mobile authority bar
  remains sticky at y=64 after scrolling.
- `bun run check` remains nonzero only on historical formatting under
  `runs/webui-control-plane-spec/` and the pre-existing `src/loop/runner.ts`
  `useAppServer` hook-name false positive. Current Web UI paths are clean.
- Independent zero-write release review: literal `PASS` for the direct
  fixture-backed React/Vite MVP scope.

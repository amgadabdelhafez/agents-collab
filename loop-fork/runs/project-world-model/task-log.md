# Task project-world-model

Created: 2026-08-04T19:07:36Z
Mode: planned
Description: Build a provenance-first temporal project context graph with deterministic materialization and read-only decision context tools

## What I changed

- Added a versioned, fail-closed ontology and local SQLite statement store.
- Added deterministic materialization from committed Git blobs, static imports,
  Markdown links, components, specs, tests, and exact evidence hashes.
- Added explicit non-authoritative assertion ingestion, temporal supersession,
  contradiction reporting, and bounded deterministic context capsules.
- Added `loop world build`, `ingest`, `context`, and `ontology` commands.
- Added producer-backed direct and CLI tests using real temporary Git repos.

## Why

Agents need one rebuildable project context projection with exact provenance and
temporal state instead of reconstructing an inconsistent local model per turn.
The projection remains read-only evidence and cannot authorize control-plane
actions.

## Notes

- Focused world-model suite: 10 pass, 0 fail.
- Full sequential suite: pass under the required local-loopback test capability.
- `bun run check`, `bun run build`, Harness preflight, and stop-gate pass.
- Repository-wide `tsc --noEmit` retains pre-existing errors; no error points to
  either world-model source or test file after the new bindings were corrected.

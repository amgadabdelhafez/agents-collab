# Task webui-harvto-live-data

Created: 2026-08-21T19:49:58Z
Mode: planned
Description: Wire the read-only Web UI to the canonical Harvto lane with a fail-closed redacted projection.

## What I changed

- Added a same-origin Harvto live-data API and a bounded, redacted server projection for the canonical lane.
- Replaced fixture-only fleet and run views with polling data from the current validated Harvto run.
- Added honest lifecycle, adapter identity, worker-state, freshness, provenance, and data-quality rendering.
- Added focused projection, validation, redaction, runtime-probe, and UI-render coverage.

## Why

The Web UI needed to show persisted Harvto lane truth without exposing prompts, transcripts, paths, credentials, raw identifiers, or unverified runtime claims.

## Notes

- Current live result: run 242 is input-required with zero runs working; the exact terminal session exists, but server birth identity is not persisted, so attach remains disabled.
- Independent zero-write review returned literal PASS after checking the code, live endpoint, and rendered desktop/mobile UI.
- Verification: focused live-data tests 6/6 (53 assertions), render test 1/1 (24 assertions), full `test:ci` regression 600/600, web build, project build, scoped formatting/lint, diff check, and a response scan with 676 candidate sensitive values and zero leaks.

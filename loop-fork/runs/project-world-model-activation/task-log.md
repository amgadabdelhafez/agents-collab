# Task project-world-model-activation

Created: 2026-08-06T01:02:21Z
Mode: planned
Description: Enable provenance-first World Model context for paired Loop startup

## What I changed

- Added default-on run-scoped World Model materialization before paired tmux
  handoff.
- Bound database, bootstrap capsule, exact commit, seeds, counts, ontology, and
  hashes into the validated run manifest.
- Added both agent-charter verification guidance and pane environment paths.
- Preserved already-live reattachment without mutation.
- Added producer-backed and cross-surface regression coverage.

## Why

Phase 0 was installed but only reachable through explicit `loop world`
commands. Ordinary loops did not consume it.

## Notes

- Base lineage: `a155573c65ddf78356f701608ce158181ccb0699`, equal to
  `origin/main` at branch creation.
- Focused verification: 181 passing tests across runtime, manifest, CLI, tmux,
  and governed-environment surfaces.
- Complete `bun run test:ci`: pass with an empty failure set when run with the
  localhost permissions required by WebSocket integration fixtures.
- The initial sandboxed complete-suite attempt and isolated proxy retry failed
  at ephemeral port bind with `EADDRINUSE`; the same proxy test passed 1/1 and
  the complete suite passed after granting localhost bind access.
- `bun run check`: pass.
- `bun run build`: pass.
- Compiled-source smoke: `loop v1.0.32`; `loop world ontology` returned
  `loop-world-v1`.
- Working-tree binary SHA-256 before commit:
  `30f6b531babbd28aef231cdade660894adfcc918a6260135c5613a6793ac63ff`.
- No live loop was restarted or mutated and no binary was deployed.

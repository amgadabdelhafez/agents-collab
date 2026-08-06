# Task release-v1-0-33

Created: 2026-08-06T05:09:04Z
Mode: planned
Description: Publish the integrated harness as a verified v1.0.33 GitHub Release

## What I changed

- Added a root, tag-only GitHub Release workflow that builds inside
  `loop-fork/`, validates tag/package identity, and publishes four native
  binaries with SHA-256 sidecars.
- Bumped the compiled Loop version to `1.0.33`.
- Added producer-backed cleanup for World Model activation when its manifest
  is absent at bind time, including finalized artifact removal.
- Added a root-release-layout regression and corrected README install/reaper
  paths for the full repository layout.
- Closed the deployed World Model activation and worktree reaper Harness task
  records with exact deployment provenance.

## Why

GitHub only discovers workflows below the repository-root `.github/workflows`
directory. After the full repository replaced the prior `loop-fork`-rooted
layout, the nested release workflow became inert and `install.sh latest`
continued to download the July 5 `v1.0.32` asset.

## Notes

- Base: `origin/main` at
  `d13b6df2175218048ac41f64ebffced0f6c6113d`, the supervisor-cleared deployed
  lineage.
- `bun run test:file -- tests/loop/world-model-runtime.test.ts`: 4 pass,
  including a real committed Git fixture with the manifest removed before
  binding and an empty run-scoped World Model directory afterward.
- `bun run test:file -- tests/release-packaging.test.ts`: 1 pass.
- `bun run check`: pass, 836 files, no fixes applied.
- Repository TypeScript no-emit command: pass.
- `bun run build`: pass; `./loop --version` reports `loop v1.0.33`.
- Working-tree binary SHA-256:
  `b5c5d97df3ad3fba07b10dd5099b05bf18f53f1f184bc8cbc227992d020d64d1`.
- The first sandboxed sorted suite attempt reached the proxy integration and
  failed at localhost bind with `EADDRINUSE`. The identical complete
  `bun run test:ci` suite passed with the documented localhost bind access.
- No tag, release, remote main, installed binary, or healthy live run was
  mutated before exact-SHA review.

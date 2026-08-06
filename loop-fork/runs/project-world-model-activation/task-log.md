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
- AS RAISED: no live loop was restarted or mutated during task implementation,
  and deployment had not yet been authorized.

## Deployment closure

- The reviewed integrated lineage was deployed as commit
  `d13b6df2175218048ac41f64ebffced0f6c6113d` to both remote `main` branches.
- `/Users/amgad/.local/bin/loop` was installed with SHA-256
  `9e8cdf43110fc2917a87ff9ce92805190e2f15b246fc136c472f7ec021f3aeb5`.
- Already-live run 137 retained its original process and session lineage; it
  was not restarted or retrofitted.

## Release-smoke integration regression

The first combined exact-binary launch smoke failed closed because its
disposable repositories were initialized without a commit. World Model
activation correctly requires `git rev-parse HEAD` for provenance. The smoke
fixture now creates and commits a real tracked seed file in every isolated repository, so
the producer-backed release smoke exercises the default-on World Model path.

Regression: yes
Regression id: world-model-launch-smoke-git-head
Regression symptom: The realistic exact-binary release smoke failed before launch because its disposable repository had no committed HEAD.
Regression guard: LOOP_SMOKE_BINARY=<exact-binary> LOOP_SMOKE_EXPECTED_SHA256=<sha256> LOOP_SMOKE_FULL_LAYOUT=1 bash evals/smoke/large-prompt-launch.sh

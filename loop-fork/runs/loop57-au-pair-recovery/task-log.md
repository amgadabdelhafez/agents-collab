# Task loop57-au-pair-recovery

Created: 2026-07-28T01:29:28Z
Mode: planned
Description: Recover live Loop 57 Au Pair path adaptation and stop stale failure replay

## What I changed

- Started from live Loop 57 evidence and captured the historical Au Pair failure.
- Confirmed utility completions target their requester, while fallback routing
  incorrectly targets Governess's current driver.
- Routed every non-peer terminal outcome to `job.request.requester`; explicit
  peer review remains the only route to the other full agent.
- Added bounded, in-scope missing-path suggestions and permitted descendant
  directory listings without permitting scope widening, symlink traversal, or
  silent path substitution.
- Added common-ancestor scope guidance to `route_task` and the mandatory helper
  prompt.
- Replaced Nanny/Au Pair body labels and generated failure-role text with the
  `QWEN`/`GLM` model family. Full model/version details remain in Governess and
  the role names remain tmux pane-border titles only.

## Why

The bridge must preserve request/response ownership independently of which full
agent Governess currently calls the driver.

## Notes

Regression: yes
Regression id: utility-route-requester-affinity
Regression symptom: Codex-originated fallback results were delivered to Claude.
Regression guard: tests/loop/utility-runtime.test.ts

## Verification

- Focused bridge/runtime/tool suite: 159 pass, 0 fail.
- Full `bun run test:ci`: 1,104 pass, 0 fail across 55 test files.
- Compiled binary build: pass.
- Independent local Qwen review: `VERDICT: PASS`, no correctness or security
  blockers.
- Live Codex-owned Au Pair canary `48b95aa5-d7bd-4acb-9c3c-219d42d8f28f`
  completed in 15.21 seconds with three successful `list_files` calls, no
  `search_repo`, no writes, and a bridge handover targeted to `codex`.
- Nanny pane `%4` and Au Pair pane `%3` were hot-swapped. Their bodies show
  `QWEN` and `GLM`; their borders remain
  `nanny.harvto-loop-57` and `au-pair.harvto-loop-57`.
- Claude pane `%0` PID `70452` and Codex pane `%1` PID `70454` were not
  restarted.

# Task lower-agent-release-integration

Created: 2026-07-26T06:24:34Z
Mode: planned
Description: Integrate lower-agent router and default pane with visible bridge fixes, then release for future loops without touching loop 40

## What I changed

- Created the dedicated `codex/lower-agent-release-integration` worktree and
  spec-first Harness run.
- Landed the lower-agent router/default-pane component as `b4827c3` and the
  visible bridge repairs as `8f24aba`.
- Merged both feature sets additively as `048ebc5` and `72838aa`, retaining
  utility routing plus the newer direct-delivery and draft-safety behavior.
- Built the combined executable and exercised both default and opt-out layouts
  in disposable tmux sessions without starting either paid main agent.

## Why

The globally installed executable contained the bridge repairs but predated the
lower-agent router. Installing the older worker branch directly would have
regressed those later repairs, so a semantic integration release was required.

## Notes

- Pre-release loop-40 panes were `%0/%1/%2/%3`, with PIDs
  `35064/35066/35520/36990`. The release procedure must preserve them exactly.
- Focused integration verification: 331 pass, 0 fail, 1,131 expectations.
- Full suite: 681 pass, 4 known baseline expectation failures involving the
  repository's current Codex model defaults; no integrated-feature regression.
- `bun run build` and `git diff --check` passed.
- Verified candidate SHA-256:
  `08b5859c414fcfcdb61aeceb24b0f87d4c7f8f150508f4e8366eb6a2da9d34ae`.
- Default 160x44 smoke geometry created a top-right 79x8 utility observer and
  preserved both main panes plus the full-width bottom governess row.
- `LOOP_UTILITY_PANE=0` restored the three-pane layout.
- The utility pane reported `LOWER AGENT z-ai/glm-5.2 READY`; bridge MCP listed
  `route_task`, `task_status`, `get_task_result`, `send_message`,
  `bridge_status`, and `receive_messages`.
- Exact credential-content scan across source, tests, specs, and run artifacts
  was clean; the key remains external and mode 0600.

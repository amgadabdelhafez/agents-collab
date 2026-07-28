# Task loop58-runtime-corrections

Created: 2026-07-28T05:56:21Z
Mode: planned
Description: Integrate Claude config isolation, enforce dormant reviewer behavior, add safe line counts, and hot-swap Loop-58

## What I changed

## Why

Loop-58 launched from this branch and proved that previously completed fixes
were not composed into the runtime actually in use. The live audit also found
contradictory reviewer ordering and an Au Pair command-policy failure on a safe
five-file line-count request.

## Notes

- Live baseline: 27 candidates, 3 helper routes, 2 successes, and one Au Pair
  `command_denied` failure.
- Claude began task reads and helper routing before a Codex review request.
- `CLAUDE_CONFIG_DIR` was absent and `loop-bridge-harvto-58` appeared in the
  real `~/.claude.json`.
- Preserve Loop-58 Codex pane `%1`, PID `49725`, thread
  `019fa744-bc24-7260-bfb0-01e11a3f92b9`, and all Harvto worktrees.

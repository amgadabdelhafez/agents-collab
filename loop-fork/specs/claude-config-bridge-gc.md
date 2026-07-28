# claude-config-bridge-gc

Task completed 2026-07-28T05:05:12Z, mode planned.

## What was built

- Added a Bun test preload that always assigns a fresh temporary
  `CLAUDE_CONFIG_DIR` and removes it after the test process exits.
- Explicitly propagate `CLAUDE_CONFIG_DIR` across detached tmux startup and
  into agent, governess, and utility pane commands. This closes the tmux-server
  environment boundary that allowed smoke runs to fall back to `~/.claude`.
- Added conservative startup GC for loop-owned `loop-bridge-*` Claude MCP
  registrations. A registration is removed only when its executable/run data
  is gone, its manifest is terminal, or a declared-active run has recorded
  liveness and that liveness is gone. Live, foreign, malformed, ambiguous, and
  missing-project entries are retained.
- Backed up `/Users/amgad/.claude.json` to
  `/Users/amgad/.claude/backups/manual-20260727T215751-0700-claude-config-gc/.claude.json`.
- Removed only the dead `/private/tmp/governess-e2e.F0GKV2` project record and
  moved its 10 transcripts (2.1 MB) to
  `/Users/amgad/.claude/quarantine/governess-e2e-F0GKV2-20260727T215751-0700`.
- Preserved the sole current registration, `loop-bridge-harvto-57`.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-28T04:50:06Z)

# Task claude-config-bridge-gc

Created: 2026-07-28T04:50:06Z
Mode: planned
Description: Isolate governess smoke tests from real Claude config, quarantine stale e2e sessions, and GC dead loop-bridge registrations at startup

## What I changed

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

## Why

Automation-created local-scope Claude MCP registrations and transcripts were
being written into the user's real home config. That made test sessions appear
resumable and allowed loop bridge instructions to load in unrelated Claude
sessions. Isolation prevents new pollution; startup GC repairs leaked loop-owned
registrations after crashes without treating the user's registry as disposable.

## Notes

- Live dry audit: `{ "failed": 0, "kept": 1, "removed": 0, "scanned": 1 }`.
- Active registry after cleanup: 28 projects, zero governess-e2e project keys,
  one loop bridge (`loop-bridge-harvto-57`).
- Focused regression suite: 70 passed, 0 failed.
- Full suite: 897 passed, 0 failed; compiled build passed.
- New/config-specific files pass Ultracite. Repository-wide `bun run check`
  still reports the pre-existing baseline of 205 diagnostics, chiefly old run
  artifacts; unrelated formatting was not rewritten.
- Already-running Claude processes retain MCP configs loaded in their argv.
  They were deliberately not killed or restarted; a normal Claude restart is
  required to shed those already-loaded tools.

Regression: yes
Regression id: claude-config-bridge-leak
Regression symptom: governess smoke runs register loop MCP servers and sessions in the real Claude home config
Regression guard: tests/loop/claude-config-gc.test.ts, tests/loop/tmux.test.ts, tests/setup.ts

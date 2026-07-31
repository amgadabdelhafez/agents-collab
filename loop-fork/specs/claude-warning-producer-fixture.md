# claude-warning-producer-fixture

Task completed 2026-07-31T06:43:54Z, mode planned.

## What was built

Captured Claude Code 2.1.220 in a private 220x60 tmux socket with a dedicated
ephemeral `CLAUDE_CONFIG_DIR`, matching strict MCP/development-channel flags,
and no prompt submission or model request. The authoritative raw evidence is
bound at `~/.loop/evidence/claude-warning-producer-fixture/20260731T054543Z`.

The producer replay failed before the source change because the ready screen had
trailing blank rows and a plain rotating suggestion. The executable red-before
artifact preserves the exact 20-second readiness timeout. The first cursor-only
fix was independently rejected because a matching human draft at Home and
separate text/cursor probes could be misclassified.

The corrected path now binds styled pane text, cursor, `window_activity`, client
count, and pipe state in one tmux command queue. It probes only a detached,
unpiped candidate after a quiet activity-second boundary; ordered `End,C-l`
must produce a later activity timestamp. The real placeholder stays at x=2. A
matching unsent draft moves to End, is restored to Home by a separately
acknowledged `Home,C-l`, and remains blocked. Any timeout or unclassifiable
state after probe keys may have been delivered preserves the live session,
marks the run `input-required`, and reports an exact attach command instead of
killing the workspace. Missing pre-probe acknowledgment, attached clients,
existing pipes, candidate drift, and restoration failure all fail closed.

Latest focused result: 87 passed, 0 failed. Producer metadata replay, Ultracite,
source typecheck, compiled build, the complete sequential suite, and the empty
baseline gate pass. Independent review CONCURred on the uncommitted source and
evidence bytes; exact-commit binding and exact-binary release proof remain.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-31T04:33:26Z)
- 002 - producer capture exposed and fixed cursor-bound Claude readiness (2026-07-31T04:52:00Z)

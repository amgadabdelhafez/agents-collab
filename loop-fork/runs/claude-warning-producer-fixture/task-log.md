# Task claude-warning-producer-fixture

Created: 2026-07-31T04:33:26Z
Mode: planned
Description: Capture and replay the real Claude development-channel pre-connect warning with complete producer provenance

## What I changed

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

## Why

Run 102 showed a transient valid-config startup warning, while existing tests
hand-author Claude's prompt shape. The fixture-provenance policy requires a real
producer capture before this seam can be certified.

## Notes

Regression: yes
Regression id: claude-dev-channel-preconnect-warning-fixture
Regression symptom: A valid development-channel MCP server is reported missing during Claude startup before the bridge becomes available.
Regression guard: bun run test:file -- tests/loop/tmux.test.ts

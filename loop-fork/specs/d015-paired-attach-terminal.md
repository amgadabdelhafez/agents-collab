# D-015: Paired attach terminal capability

## Problem

Installed loop v1.0.38 can successfully create and verify a detached paired
tmux session, then exit nonzero because the initiating terminal cannot perform
the optional foreground attach. AI-CUR Run 17 produced:

```text
open terminal failed: terminal does not support clear
[loop] error: Failed to attach to tmux session "ai-cur-loop-17".
```

The run remained live and ready with all six panes. A retry then encountered a
correct workspace-ownership conflict, making the attach-only failure look like
a launch failure and encouraging duplicate launches.

## Required behavior

- Session creation and required liveness checks remain fail-closed.
- After a session is proven live, an interactive attach error is non-fatal.
- The launcher logs an attach-only warning, the exact socket-aware manual
  attach command, and exits successfully while preserving the live run.
- A session that disappears before or during handoff remains a real failure.
- Paired-session ownership and persistent Codex transport are released only
  through the existing successful-live-session path.
- Non-interactive, already-inside-tmux, and ordinary successful attach behavior
  remains unchanged.

## Scope

- `src/loop/tmux.ts`
- focused tests in `tests/loop/tmux.test.ts`
- Harness run evidence for this task

## Non-goals

- D-014 failed-start cleanup ordering
- tmux persistence across a computer restart
- worktree durability under `/private/tmp`
- socket normalization, session naming, panel behavior, product repos, or
  installed-binary deployment

## Acceptance

1. A synthetic interactive attach exception with a still-live session returns
   successful handoff, logs an attach-only warning and exact manual command,
   and does not terminalize a paired run.
2. A vanished session still returns the current non-handoff result and follows
   existing failed-start handling.
3. A true paired creation/readiness error still rejects.
4. Focused tmux tests, type/style checks, build, and `git diff --check` pass.
5. A separate zero-write reviewer returns `PASS` before commit.

# Spec: Babysitter Exit Control

## Problem

The babysitter pane has no keyboard-controlled lifecycle actions. Ending a loop
requires leaving the workspace and manually deciding whether to destroy it or
prepare a fresh paired session, which risks losing handoff context or killing
agents mid-turn.

## Goal

Make `x` open an exit menu in the babysitter pane:

- `e` tears down the current loop.
- `h` performs a graceful handover to a fresh loop.
- `Esc`, `c`, or `x` closes the menu without side effects.

## Handover contract

1. The babysitter never types over an active agent. It waits for each agent to
   become idle before delivering the handover request.
2. Each request tells the agent to finish only its current atomic step, update
   `PLAN.md` and `status.md`, preserve uncommitted work, send concise peer
   context, and exit its own TUI. It must not commit, push, merge, or deploy
   unless that authority already exists.
3. The babysitter waits without a destructive timeout until both agent TUIs
   have exited. During that wait, `e` remains available as a forced teardown.
4. Once both exited, the babysitter starts a fresh paired, babysat tmux loop in
   the same cwd with the same primary/peer pairing and a prompt to continue from
   `PLAN.md`, `status.md`, repo state, and the prior run transcript.
5. The old session is killed only after the new loop launch succeeds. A launch
   failure keeps the old babysitter alive and displays the error.

## Acceptance criteria

- [x] A TTY key reader handles single-key input without requiring Enter and
      restores terminal mode on shutdown.
- [x] `x` only opens the menu; it never tears down or messages an agent.
- [x] `e` marks the run stopped and kills only the current tmux session.
- [x] `h` persists handover progress and does not inject into busy agents.
- [x] The replacement loop uses fresh agent sessions, the same cwd/pairing,
      `--tmux --babysit`, and a source-of-truth handover prompt.
- [x] Replacement launch failure never kills the old session.
- [x] The normal babysitter behavior is unchanged until `x` is pressed.
- [x] Focused tests, full babysitter tests, and build pass.

## Non-goals

- Automatically committing, pushing, merging, deploying, or resolving dirty
  worktrees.
- Forcing agents to exit after a timeout.
- Resuming the old Claude/Codex session IDs in the replacement loop.

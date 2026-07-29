# Governess pane liveness

## Problem

The paired workspace enables tmux `remain-on-exit` for the whole window. When
the Governess process exits unexpectedly, tmux intentionally retains the dead
pane and its final alternate-screen frame. The pane therefore looks healthy
but frozen even though no Governess render or control loop remains.

This was observed on Harvto run 100 after the Governess received `SIGTERM`.
The pane stayed visually unchanged for about 24 minutes until the process was
manually recovered. Because the border shows only the static pane label, the
workspace does not disclose that the process is dead.

## Goal

A dead Governess pane is immediately unmistakable and is automatically
respawned only while its exact run, session, and pane ownership remain active,
with a durable restart budget that prevents crash loops.

## Requirements

1. The tmux border and retained dead-pane body must visibly say that a pane is
   stopped when `pane_dead` is true; frozen output must not look live.
2. Each newly created Governess pane receives a pane-scoped `pane-died` hook
   that invokes a hidden loop lifecycle helper without running normal CLI
   startup maintenance.
3. Before respawning, the helper must verify all of the following against
   current state: the manifest parses, its lifecycle state is active, its
   `tmuxSession` equals the requested session, its `tmuxPaneGoverness` equals
   the requested pane, the session exists, and that exact pane still exists
   and is dead.
4. Ownership and dead-pane state must be re-read immediately before the
   respawn action. Terminal, missing, malformed, stale, live, or mismatched
   state must fail closed without mutation.
5. Automatic recovery is limited to at most three respawn attempts in a
   rolling five-minute window. Attempts and outcomes are appended to a durable
   run-owned JSONL journal before and after the tmux action. Invalid existing
   budget evidence fails closed instead of resetting the budget.
6. Respawn uses tmux's recorded original pane command so the original
   Governess environment and arguments are preserved. A successful respawn
   keeps the pane identity and pane-scoped hook.
7. Intentional teardown must not trigger recovery: the normal teardown path
   marks the manifest terminal before destroying the tmux session, and the
   helper independently rejects terminal manifests or absent sessions.
8. Verification must use isolated/fake tmux state only. Harvto run 100 and its
   processes, panes, manifest, and files are read-only unless its supervisor
   explicitly authorizes a later narrow hot-swap.

## Non-goals

- Ignoring `SIGTERM` or changing the Governess process's signal semantics.
- Killing or classifying tmux server/client processes from retained argv.
- Restarting main agents, utility workers, or recon panes.
- Mutating or deploying into the active Harvto run during implementation.
- Adding a general-purpose process supervisor.

## Acceptance criteria

- [x] Static pane labels remain readable while dead panes gain an explicit
      stopped treatment in both the border and retained pane body.
- [x] A fresh Governess pane is armed with a pane-local `pane-died` hook bound
      to its canonical run directory, deterministic session, and stable pane.
- [x] The hidden helper respawns an exact active, owned, dead Governess pane.
- [x] The helper spares inactive, missing, malformed, mismatched, absent, and
      already-live targets.
- [x] The fourth attempt inside five minutes is suppressed durably; a later
      attempt outside the window is permitted.
- [x] Focused tests and the repository verification suite pass with an empty
      baseline-failure list.
- [ ] A different reviewer issues an exact-SHA CONCUR before deployment.

## Out-of-scope risks

`remain-on-exit` applies to every pane, so the visible formatting must remain
generic and must not disturb current live-pane labels. The recovery hook is
Governess-only and must not broaden automatic respawn authority to peer agents
or helpers.

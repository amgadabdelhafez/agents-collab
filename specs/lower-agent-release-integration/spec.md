# Spec: Lower-Agent Release Integration

## Problem

The completed lower-agent router and default observer-pane implementation is
isolated in `codex/lower-agent-router`, while later bridge visibility and
Codex-to-Claude latency fixes are isolated in `codex/codex-bridge-visible-tui`.
Both branches are based on the same older tip and modify overlapping bridge
files. The currently installed binary contains the bridge repairs but not the
utility tier, so new loops cannot launch the requested worker pane or advertise
the routing tools.

## Goal

Produce one locally integrated, verified release containing both feature sets,
merge it into the canonical local branch, and atomically install its binary for
future loops without modifying or restarting the active loop 40.

## Requirements

1. Preserve the fail-closed GLM-5.2/OpenRouter utility router, bounded tools,
   durable jobs, governess scheduling, bridge tools, and default observer pane.
2. Preserve visible Codex bridge delivery, visible Claude delivery,
   non-empty-draft protection, proxy reconnect behavior, and atomic
   direct-delivery/worker claims.
3. Resolve overlapping bridge code semantically; do not select either worktree
   wholesale where that would discard behavior from the other.
4. New governed paired tmux loops show the utility observer at the top-right by
   default. `LOOP_UTILITY_PANE=0` remains the explicit opt-out.
5. The OpenRouter credential remains outside the repository, mode 0600, and is
   never emitted into tests, artifacts, process arguments, or logs.
6. Release installation is atomic and retains a recoverable backup of the
   previously installed executable.
7. No process, pane, composer, bridge queue, or persisted state belonging to
   live loop 40 is changed during integration or release.
8. Nothing is pushed remotely.

## Acceptance criteria

- [ ] Combined lower-agent, bridge, proxy, governess, run-state, argument, and
      tmux focused tests pass.
- [ ] Full tests and build run; unrelated baseline failures are isolated.
- [ ] `git diff --check` passes.
- [ ] A disposable tmux smoke test proves default top-right utility geometry
      and the explicit opt-out without launching paid main agents.
- [ ] The integrated binary advertises GLM-5.2 utility configuration and the
      bridge routing tools while retaining the visible bridge paths.
- [ ] The integrated branch is merged locally into the canonical branch and
      its binary is installed atomically for future loops.
- [ ] Loop-40 Claude, Codex, Governess, and judge pane IDs and PIDs are
      identical before and after release.

## Non-goals

- Retrofitting the worker pane into loop 40.
- Restarting any loop-40 process.
- Routing a live loop-40 task through the utility worker.
- Pushing or opening a remote pull request.

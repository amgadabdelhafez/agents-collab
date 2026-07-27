# Spec: Utility Worktree Adoption

## Problem

Loop 47's utility worker handled the initial repository reads, then stopped
receiving useful work after the agents began operating in
`/private/tmp/harvto-loop47-base`. The run manifest and worker remained rooted
at `/Users/amgad/harvto`, so later absolute scopes in the active Git worktree
failed closed as `protected-scope`. Reviews correctly routed to the peer, but
mechanical inspections in the verified worktree fell back to a full agent.

## Goal

Make utility routing and execution aware of an active linked Git worktree while
preserving the existing fail-closed containment boundary. A worktree is trusted
only when Git proves it belongs to the same canonical repository as the run's
configured root.

## Requirements

1. Resolve one request workspace root before routing. Relative scopes continue
   to use the run root.
2. An absolute scope outside the run root may select a linked worktree only when
   its Git common directory matches the run root's Git common directory.
3. All request read/write scopes must belong to the same resolved workspace;
   mixed roots, unrelated repositories, non-Git directories, and unresolved
   paths fail closed.
4. Preserve the pure router and its existing path, authority, capability,
   conflict, and protected-file checks by routing against the resolved root.
5. Persist the verified workspace root with the routed job so detached workers,
   tools, guarded patch proposals, and applies use the same boundary.
6. Never trust a caller-supplied workspace root without local Git verification.
7. Do not broaden access to credentials, agent settings, governing specs, or
   paths outside the verified worktree.
8. Existing loops rooted directly in their repository remain compatible.
9. Add observable route detail for worktree-root mismatch without exposing
   credentials or raw command output.
10. Integrate locally, rebuild, and refresh only lower display/control panes if
    live adoption requires a governess restart. Do not interrupt Claude/Codex
    and do not push remotely.

## Acceptance criteria

- [ ] A request scoped to a linked worktree of the run repository routes to
      utility and the worker reads from that worktree, not the base checkout.
- [ ] A same-path request against an unrelated repository remains
      `protected-scope`/driver.
- [ ] Mixed base/worktree or two-worktree scopes fail closed.
- [ ] Symlink escapes and protected paths remain denied.
- [ ] Focused router/runtime/bridge/tool tests, broad integration tests, build,
      and `git diff --check` pass.
- [ ] Independent evaluation records PASS before integration.
- [ ] A live loop 47 worktree inspection reaches GLM without changing the main
      agent pane IDs/PIDs.

## Non-goals

- Delegating peer review or product/architecture decisions to GLM.
- Allowing arbitrary temporary directories.
- Increasing worker concurrency or token limits.
- Changing the tmux layout.

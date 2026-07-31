# Spec: Explicit Utility Workspace Binding

## Problem

`route_task` binds repo-relative scopes to the loop run's canonical checkout.
When a driver works in a registered linked worktree, helpers therefore reject or
misread otherwise-safe packets unless every scope is rewritten as an absolute
path. In run 102, all nine edit packets were lost to this mismatch: eight were
returned to the driver and one ran against the wrong checkout.

The current failure is also reported as `protected-scope`, even when no
protected path was requested, which sends the driver toward the wrong remedy.

## Goal

A requester can explicitly bind one bounded helper packet to a verified linked
worktree while continuing to use repo-relative scopes, and invalid roots fail
closed with an actionable workspace-specific reason.

## Non-goals

- Do not let helpers discover or select worktrees on their own.
- Do not accept unregistered directories, unrelated repositories, symlink
  aliases, directory-wide edit scopes, or mixed-worktree authority.
- Do not change the rule that an edit may write only one or two exact files.
- Do not deploy a binary until independent review and the full release gate pass.

## Background

The existing resolver already verifies absolute paths against Git's registered
worktree list and common directory. It also safely admits an absent exact write
target when its nearest existing parent is a real directory within the selected
root. This feature exposes an explicit root selector and reuses those boundaries;
it does not broaden file authority.

## User journeys

1. A driver submits `workspace_root=/path/to/registered-worktree` plus relative
   read/write scopes; Governess verifies the root and routes the normalized job
   in that worktree.
2. A driver omits `workspace_root`; all relative scopes continue to bind to the
   canonical loop checkout.
3. A driver supplies an unrelated, unregistered, aliased, or conflicting root;
   the job returns to the requester as `workspace-unverified` with no worker spawn.

## Acceptance criteria

- [ ] `route_task` documents and accepts optional `workspace_root`.
- [ ] The selected root is exactly the canonical run root or an exact registered
      linked worktree with the same Git common directory.
- [ ] Relative scopes under an explicit root normalize under that root, including
      a missing exact write target; the decision persists the verified root.
- [ ] Explicit roots reject absolute/mixed scope forms, symlink aliases, unrelated
      repositories, unregistered directories, directory writes, and symlink-parent
      writes without spawning a helper.
- [ ] Omission preserves current canonical-root and absolute-scope behavior.
- [ ] Workspace selection failures use `workspace-unverified`; genuine protected
      paths continue to use `protected-scope`.
- [ ] A guarded new-file proposal records a null preimage, creates only the linked
      target, and fails on a pre-creation race.
- [ ] Focused tests, full tests, checks, build, smoke, and preflight pass with an
      empty baseline-failure allowlist.

## Out-of-scope risks

The request format and stable idempotency key change. Tests must prove the root
participates in request identity and survives the append/read round trip. The
normalizer must not turn a relative scope into authority outside the verified root.

## Open questions

- [x] Root selector name: `workspace_root`, matching the external snake-case tool
      schema and `workspaceRoot` in persisted TypeScript records.
- [x] Compatibility: omission retains existing behavior.

# Plan: Explicit Utility Workspace Binding

## Approach

Carry an optional untrusted workspace root in the route request. Verify it in the
existing workspace resolver, then resolve only repo-relative packet paths beneath
that exact root. This keeps authority enforcement centralized and preserves the
existing absolute-scope compatibility path for older callers.

## Sequence

1. Extend the persisted request and bridge schema with `workspace_root` and clear
   linked-worktree guidance.
2. Verify the requested root against the run root, Git common directory, and
   registered worktree roots before normalizing relative scopes.
3. Distinguish root-resolution failures from protected-path routing failures.
4. Add unit, bridge, runtime, and guarded-apply regression tests covering run-102
   behavior and all fail-closed cases.
5. Run Harness-recorded focused and full verification, obtain independent review,
   and only then consider a binary deploy.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Workspace selection | Explicit optional root | Deterministic; no helper discovery or guessing |
| Trust boundary | Existing Git registration/common-dir verifier | Reuses the established fail-closed boundary |
| Explicit-root scope form | Relative only | Prevents mixed-root ambiguity and keeps packets readable |
| Failure reason | `workspace-unverified` | Separates checkout binding failures from protected paths |
| Compatibility | Keep omission and legacy all-absolute path support | Avoids breaking existing callers |

## Affected subsystems

- Bridge utility API — new optional input and guidance.
- Task router records — persisted workspace selector and stable request identity.
- Utility workspace resolution — explicit-root verification and normalization.
- Utility runtime/observability — workspace-specific routing reason.
- Utility tools — end-to-end absent-preimage guarded apply coverage.

## Risks

- Root aliases could bypass registration checks. Mitigation: require the supplied
  path to equal its canonical real path and an exact registered root.
- Existing packets could change identity. Mitigation: omit the field entirely when
  absent and add idempotency tests.
- Misclassified errors could hide protected-path denials. Mitigation: protected
  path checks remain in the pure router; only resolver failures use the new reason.

## Not doing

No automatic worktree inference, no directory edit permission, no helper-managed
worktree registration, and no loosening of patch/preimage validation.

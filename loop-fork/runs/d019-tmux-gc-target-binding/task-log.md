# Task d019-tmux-gc-target-binding

## Objective

Prevent ambient tmux state from granting destructive GC authority.

## Verification

- Bound Claude registration GC and abandoned-run process GC to manifest-backed
  `TmuxTarget` values.
- Missing, invalid, conflicting, no-session, and indeterminate liveness preserve
  ownership and emit field-complete structured skip evidence.
- Same-named sessions on separate sockets are probed independently; only exact
  confirmed-dead targets can contribute destructive authority.
- Focused suites: 28/28 pass; loop CLI suite: 41/41 pass.
- Exact four-file Ultracite check, build, and diff check pass.
- Independent zero-write review: PASS.

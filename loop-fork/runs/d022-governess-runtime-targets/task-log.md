# Task d022-governess-runtime-targets

## Objective

Remove ambient tmux authority from the main Governess runtime and handoff.

## Verification

- Six focused suites passed: 236 tests, 0 failures, 1030 assertions.
- Exact eight-file Ultracite check passed.
- `bun run build` passed.
- `git diff --check` passed.
- Independent zero-write review passed after correcting workspace-release and
  batched-pane snapshot races.

## Result

- Default Governess tmux effects now derive session and pane authority from
  coherent manifest handles.
- Workspace handoff durably releases the reservation while retaining the exact
  predecessor socket and session for later teardown.
- Degraded, mismatched, or changed targets fail closed before tmux contact.

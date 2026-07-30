# Registered worktree command root

## Problem

Automatic utility routing uses the hook payload's session `cwd` to classify
relative paths. Codex `exec_command` can execute in a different literal
`tool_input.workdir`, but that field is currently ignored. In run 101, commands
executed in `/private/tmp/harvto-loop65-base` were routed with
`workspace.root=/Users/amgad/harvto`; Direct and Nanny then produced false
`not_found` and `context-insufficient` terminal results.

## Requirements

- Treat a literal shell-tool `workdir` as the command's effective cwd before
  classifying scopes.
- Resolve a leading literal `cd` relative to that effective cwd.
- Adopt the resulting root only through the existing same-Git-common-directory
  verifier; never trust the tool payload directly.
- If an explicit workdir or leading-cd hint is not verified, fail open to the
  requesting main agent instead of falling back to the run root.
- Persist adopted scopes as absolute paths so the utility workspace boundary
  re-verifies and records the selected linked worktree.
- Preserve every existing protected-path, mixed-root, unsafe-command, tool,
  authority, and secret boundary.

## Acceptance

- A bounded search/read with session cwd at the primary checkout and a verified
  linked-worktree `workdir` routes with absolute scopes in that worktree.
- Relative leading `cd` is resolved once, relative to `workdir`.
- An unrelated or malformed workdir produces `workspace-unverified` and no
  utility request.
- Existing primary-root and leading-`cd` behavior remains green.
- Focused tests, full per-file CI tests, build, check, and diff checks pass.

## Non-goals

- Broadening eligible command grammar or worker permissions.
- Activating a new binary or hook configuration in run 101.
- Changing tmux layout, routing concurrency, or model selection.

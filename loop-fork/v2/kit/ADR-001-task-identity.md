# ADR-001: Task Identity Uses a File Marker

## Status

Accepted for Phase 1.

## Context

Harness v2 needs one cheap way for agents, hooks, and shell commands to know
which task is active. The first design said `task <id>` should export
`TASK_ID`, but a normal child process cannot mutate the parent shell's
environment. A script can print export commands, but the caller must evaluate
them explicitly.

## Decision

Phase 1 writes the active task id to `.harness/current-task`.

The file contains only the task id and a trailing newline. It is the source of
truth for active task identity. Future hooks should read this file directly
instead of depending on an environment variable.

## Escape Hatch

`task.sh` supports `--emit-env` for users who prefer shell variables:

```bash
eval "$(v2/kit/scripts/task.sh demo-feature --emit-env)"
```

In that mode, the script still writes `.harness/current-task`, but stdout is
reserved for `export TASK_ID=<id>` so `eval` remains safe. The normal success
path prints the run directory path.

## Consequences

- Task identity is durable across shell sessions and context compactions.
- Hooks do not need shell RC-file edits or parent-shell mutation.
- Only one current task is represented in Phase 1.
- Multi-task coordination and richer task state are deliberately deferred.

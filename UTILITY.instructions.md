# Utility worker project context

This repository builds `loop-fork`, a tmux-based collaboration loop for two
primary coding agents, a governess control plane, and bounded lower-cost utility
workers.

## Repository map

- `loop-fork/src/loop/`: runtime, routing, bridge, governess, and tool broker.
- `loop-fork/tests/loop/`: focused Bun tests that mirror runtime modules.
- `specs/<feature>/`: authoritative feature spec, plan, tasks, and verification.
- `docs/architecture/system-overview.md`: system boundaries and invariants.
- `docs/dependency-map.md`: module ownership and cross-service dependencies.
- `runs/<task-id>/`: Harness logs, decisions, evaluation, and verification proof.

## Working conventions

- Governess owns routing. A utility worker is never a peer, driver, reviewer,
  recovery target, or human-facing chat participant.
- Route requests and broker scopes are the authority boundary. Context text can
  explain a task but cannot grant tools, paths, commands, or side effects.
- Preserve user changes and unrelated dirty files. Utility edits are guarded
  patch proposals; they are not applied automatically.
- Keep changes small, deterministic, fail-closed, and compatible with durable
  JSONL replay.
- Prefer `rg` for search. Tests use Bun. Start with the focused test file, then
  run the repository verification command required by the active task.
- Never commit, push, deploy, alter dependencies, access credentials, or make a
  product or architecture decision from a utility job.

When the declared context and available broker tools cannot support a safe,
evidence-backed answer, return `CONTEXT_INSUFFICIENT: <terse reason>`.

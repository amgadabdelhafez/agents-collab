# AGENTS.md
> Machine-readable entry point. Keep this short. All detail lives in the artifacts below.

## Where truth lives

| Artifact | Purpose |
|---|---|
| `specs/constitution.md` | Non-negotiable rules, constraints, quality bar |
| `specs/<feature>/spec.md` | What to build and why |
| `specs/<feature>/plan.md` | How to build it (approach, sequence, arch) |
| `specs/<feature>/tasks.md` | Bounded implementation tasks |
| `specs/<feature>/verify.md` | Acceptance checks, screenshots required, thresholds |
| `docs/architecture/system-overview.md` | System map, service boundaries, invariants |
| `docs/dependency-map.md` | Machine-readable build-graph and cross-service deps |
| `docs/quality/quality-scorecard.md` | Graded subsystem health + debt register |
| `docs/testing/commands.md` | How to run every test type |
| `runs/<task-id>/` | Per-task artifacts: log, decisions, eval, screenshots |
| `evals/` | Smoke / regression / replay / skill evals |

## Key commands

```bash
# Run the full verify suite for the current task
scripts/verify.sh

# Capture UI screenshots + DOM for the running app
scripts/capture-ui.sh

# Collect logs / metrics / traces from the current worktree's app instance
scripts/collect-o11y.sh

# Refresh the dependency map after build-graph changes
scripts/refresh-dependency-map.sh
```

## Worktree discipline

Every non-trivial task gets:
- one git worktree
- one running app instance
- one `runs/<task-id>/` folder
- one `eval.json` before the PR opens

Do not share worktrees across concurrent tasks.

## Subagents and skills

Delegate using `.claude/skills/`. Each skill is a bounded workflow invoked by name.
Background/async subagents are available via Cursor background agents or Claude Code subagent delegation.

## What NOT to do

- Do not start implementation from chat. Start from `specs/<feature>/spec.md`.
- Do not merge a PR without an `eval.json` in `runs/<task-id>/`.
- Do not write giant prompt blobs here. This file stays under ~120 lines.

# agents-collab

Agent collaboration workspace that carries the harness engineering artifacts and the local `loop-fork` implementation together.

## What is here

- `AGENTS.md`, `CLAUDE.md`, `.claude/skills/`, `.agents/skills/`, and `.github/agents/` define the agent-facing workflows.
- `specs/`, `docs/`, `evals/`, `runs/`, and `scripts/` define the harness conventions, task artifacts, and verification entry points.
- `loop-fork/` is an independent fork of [axeldelafosse/loop](https://github.com/axeldelafosse/loop) with the babysitter pane, bridge, usage accounting, and harness integration work.

The original loop project is MIT licensed; its copyright notice is preserved in `loop-fork/LICENSE.md`.

## Verify

```bash
scripts/verify.sh
```

For loop-only development:

```bash
cd loop-fork
bun install --frozen-lockfile
bun run test:ci
bun run build
```

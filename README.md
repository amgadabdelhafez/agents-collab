# agents-collab

A development workspace for Loop, a tmux-based harness that pairs Claude Code
and Codex for long-running agent-to-agent coding sessions.

The active implementation is in [`loop-fork/`](loop-fork/README.md).

## Repository layout

- `loop-fork/` — Loop CLI, runtime, tests, and detailed documentation
- `specs/` — feature specifications, plans, tasks, and verification criteria
- `docs/` — architecture, testing, and operating notes
- `evals/` — regression and behavior evaluations
- `runs/` — task-specific evidence and verification artifacts

## Quick start

```bash
cd loop-fork
bun install
bun test
bun run build
```

Loop can launch coding agents with broad permissions. Run it in an isolated VM
or similarly controlled environment, and review the safety guidance in the
[Loop README](loop-fork/README.md) before use.

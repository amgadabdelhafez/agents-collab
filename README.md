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
bun run test:ci
bun run build
```

## Safe worktree hygiene

Audit registered linked worktrees without changing them:

```bash
python3 scripts/reap-worktrees.py
```

The audit proves each candidate is merged into the exact `origin/main` commit,
clean including untracked files, and unused by any process cwd. To remove only
the candidates that pass every check, rerun explicitly in apply mode:

```bash
python3 scripts/reap-worktrees.py --apply
```

The command never forces removal or deletes branches. Any failed safety check
keeps the worktree and returns a visible failure.

Loop can launch coding agents with broad permissions. Run it in an isolated VM
or similarly controlled environment, and review the safety guidance in the
[Loop README](loop-fork/README.md) before use.

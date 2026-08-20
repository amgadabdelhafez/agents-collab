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

## Current integration plan

The completed Harvto supervisor fixes are published as a conflict-minimizing
linear feature stack. See the [branch and verification map](docs/harvto-supervisor-defect-stack.md)
and the [D11/D12 next-phase plan](docs/harvto-supervisor-next-phase.md).

## Quick start

```bash
cd loop-fork
bun install
bun run test:ci
bun run build
```

To install the latest verified GitHub Release on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/amgadabdelhafez/agents-collab/main/loop-fork/install.sh | bash
```

## Safe worktree hygiene

`git worktree prune --verbose` removes registrations whose directories are
already gone. Before removing a real worktree, verify all three properties
directly: its tracked and untracked status is empty, its tip is reachable from
the intended retained remote branch, and no live process has that directory as
its working directory. Remove the worktree without `--force`, then handle its
branch as a separate retention decision.

There is currently no repository-owned automatic worktree reaper. Do not rely
on historical documentation that refers to `scripts/reap-worktrees.py`.

Loop can launch coding agents with broad permissions. Run it in an isolated VM
or similarly controlled environment, and review the safety guidance in the
[Loop README](loop-fork/README.md) before use.

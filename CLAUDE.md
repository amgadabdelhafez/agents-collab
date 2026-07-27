# CLAUDE.md
> Advisory norms for Claude (planning, evaluation, architecture). Keep this short.
> All detail is in specs/, docs/, and .claude/skills/.

## Role split

**Claude handles:** planning, investigation, architecture review, UI/product critique,
security/perf review, evaluation, and subagent delegation.

**Codex handles:** bounded implementation, migrations, refactors, PR follow-up,
mechanical test repair, repo maintenance loops.

When in doubt: Claude plans and evaluates. Codex implements.

## Operating loop

1. Read `specs/constitution.md` first on any new task.
2. Read or write `specs/<feature>/spec.md → plan.md → tasks.md` before touching code.
3. Get human approval on the spec bundle before implementation starts.
4. Implementation runs in a dedicated worktree; artifacts land in `runs/<task-id>/`.
5. Evaluation runs against `specs/<feature>/verify.md` — not self-review.
6. PR opens only after `eval.json` exists and passes.

## Hooks

**Registered and verified** in `.claude/settings.json` — these fire whether or not Claude
agrees with them. Details: [`docs/project-hooks.md`](docs/project-hooks.md).

- `PreToolUse` on `Bash` → **bulk staging is blocked**: `git add -A`, `git add .`,
  `git add --all`, `git add :/`, `git stage -A`, `git commit -a` / `-am`. Stage explicit
  paths. No environment-variable bypass.
- `PreToolUse` on `Bash|Write|Edit|MultiEdit|NotebookEdit` → **writes to protected config
  are blocked**: `.claude/settings*.json`, `scripts/hooks/**`, `.gitignore`, and the
  user-level `~/.claude` / `~/.codex` files. Reads are never blocked.

Also real, but scoped to the vendored subdirectory: `loop-fork/.claude/settings.json`
registers `PostToolUse` on `Write|Edit` → `bun x ultracite fix`. It applies to sessions
rooted in `loop-fork/`, not to this repo.

**Intended, NOT implemented** — no hook enforces these today, so treat them as norms you
have to follow yourself, and do not cite them as automatic:
- Pre-completion: test run required on any code task.
- On exit: append one-paragraph entry to `runs/<task-id>/task-log.md`.
- On UI tasks: `scripts/capture-ui.sh` must succeed before eval.
- On dependency changes: `scripts/refresh-dependency-map.sh` must run.

## Skills (invoke by name)

| Skill | When to use |
|---|---|
| `fix-issue` | Triaging and fixing a tracked bug |
| `ui-evaluator` | Screenshot + DOM + flow evaluation |
| `risk-review` | Pre-merge risk pass on a PR diff |

## Context engineering rules

- Pass `docs/dependency-map.md` when reasoning about cross-module impact.
- Pass `docs/quality/quality-scorecard.md` when prioritizing debt or refactoring.
- Pass the feature's `verify.md` to every evaluator agent.
- Do not stuff the 1M window. Rank and select; don't dump.

## CLAUDE.md stays short

If you find yourself adding more than a paragraph here, it belongs in a skill, a spec, or a doc instead.

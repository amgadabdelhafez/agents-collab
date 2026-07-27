# Agent Instructions

This is the convention file read by Codex CLI, OpenAI agents, and other tools that look for `AGENTS.md` at the repo root.

**For full repo context — role split, operating loop, commands, worktree discipline, skills, known drift — read [CLAUDE.md](CLAUDE.md).** It is the canonical instruction file and is kept in sync.

## Quick reference for agents

- **Non-negotiable rules:** [`specs/constitution.md`](specs/constitution.md) — read first on any task
- **Architecture invariants:** [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)
- **Feature contract:** `specs/<feature>/spec.md` → `plan.md` → `tasks.md` → `verify.md`
- **Per-task artifacts:** `runs/<task-id>/` — `task-log.md` and `eval.json`
- **Skills:** [`.claude/skills/`](.claude/skills) — `fix-issue`, `ui-evaluator`, `risk-review`
- **Vendored harness:** [`loop-fork/`](loop-fork) has its own `AGENTS.md`; it wins on coding standards and quick commands for code inside that directory.

## Hard rules (don't violate)

- Never merge or push to `main`. Work on a branch; the supervisor merges.
- Never start implementation from chat. Start from `specs/<feature>/spec.md`, with human approval on the spec bundle.
- No PR without a passing `eval.json` in `runs/<task-id>/`, written by an agent other than the implementer.
- `baseline_failures` is an allowlist of exact test names and must be empty to release — never a count, never a flag.
- Live-loop verification is identity-only: record pane IDs/PIDs before and after, and never send input to, restart, or signal a live agent pane.
- Never commit secrets. Credentials stay in the provider process environment and out of prompts, traces, and artifacts.
- One worktree, one app instance, one `runs/<task-id>/` per task. Do not share worktrees across concurrent tasks.

## Commands

```bash
cd loop-fork && bun test && bun run check && bun run build && git diff --check
scripts/verify.sh          # repo-level baseline-allowlist gate
```

Everything else lives in CLAUDE.md. Do not write giant prompt blobs here — this file stays a pointer, well under ~120 lines.

# CLAUDE.md
> Canonical instruction file for this repo. `AGENTS.md` is a slim pointer to this file.
> Keep it short. Detail belongs in `specs/`, `docs/`, and `.claude/skills/`.

## Role split

**Claude handles:** planning, investigation, architecture review, UI/product critique,
security/perf review, evaluation, and subagent delegation.

**Codex handles:** bounded implementation, migrations, refactors, PR follow-up,
mechanical test repair, repo maintenance loops.

When in doubt: Claude plans and evaluates. Codex implements.

## Where truth lives

| Artifact | Purpose |
|---|---|
| `specs/constitution.md` | Non-negotiable rules, constraints, quality bar |
| `specs/<feature>/spec.md` | What to build and why |
| `specs/<feature>/plan.md` | How to build it (approach, sequence, arch) |
| `specs/<feature>/tasks.md` | Bounded implementation tasks |
| `specs/<feature>/verify.md` | Acceptance checks, screenshots required, thresholds |
| `docs/architecture/system-overview.md` | System map, boundaries, **architecture invariants** |
| `docs/dependency-map.md` | Machine-readable build-graph and cross-module deps |
| `docs/quality/quality-scorecard.md` | Graded subsystem health + debt register — still a template, see Known drift |
| `docs/testing/commands.md` | How to run every test type — still a template, see Known drift |
| `runs/<task-id>/` | Per-task artifacts: log, decisions, eval, screenshots |
| `evals/` | Smoke / regression / replay / skill evals |

`loop-fork/` is a vendored subproject with its own `AGENTS.md` and `CLAUDE.md`. For code
inside that directory, its files win on coding standards and quick commands; this file
still governs the spec/eval/worktree process around the change.

## Operating loop

1. Read `specs/constitution.md` first on any new task.
2. Read or write `specs/<feature>/spec.md → plan.md → tasks.md` before touching code.
   Do not start implementation from chat.
3. Get human approval on the spec bundle before implementation starts.
4. Implementation runs in a dedicated worktree; artifacts land in `runs/<task-id>/`.
5. Evaluation runs against `specs/<feature>/verify.md` — not self-review. The evaluator
   must be a different agent from the implementer.
6. PR opens only after `eval.json` exists in `runs/<task-id>/` and passes. The supervisor
   merges; do not merge or push to `main`.

## Key commands

For anything under `loop-fork/`, the bun suite is the real gate — it is what every
`specs/*/verify.md` in this repo actually runs. `scripts/verify.sh` currently enforces
only the baseline-failure allowlist; its lint/typecheck/unit/integration steps are still
`[CONFIGURE]` stubs.

```bash
# Real verification for loop-fork changes
cd loop-fork
bun test                 # full suite
bun run check            # lint + types + style (biome)
bun run build            # build the executable
git diff --check

# Repo-level wrappers
scripts/verify.sh                  # baseline-allowlist gate (+ [CONFIGURE] stubs)
scripts/capture-ui.sh              # screenshots + DOM for a running app
scripts/collect-o11y.sh            # logs / metrics / traces from this worktree's instance
scripts/refresh-dependency-map.sh  # refresh docs/dependency-map.md after build-graph changes
```

## Worktree discipline

Every non-trivial task gets:
- one git worktree
- one running app instance
- one `runs/<task-id>/` folder
- one `eval.json` before the PR opens

Do not share worktrees across concurrent tasks.

## Live verification is identity-only

When a change is verified against a live loop session: record pane IDs and PIDs before
and after, and confirm they are unchanged. Do not send input to, restart, or signal a
live agent pane. Use fake providers, fake PIDs, and disposable repositories/tmux
sessions for all destructive, timeout, and pane tests.

## Baseline failures

`baseline_failures` in `eval.json` is an allowlist of **exact test names** — never a
count, never a flag. `"baseline_failures": 4`, `"baseline_failures": true`, and the
retired `"result": "pass_with_baseline_failures"` are invalid records. **The allowlist
must be empty to release.** `scripts/check-baseline-allowlist.py` enforces this and
`risk-review` sets `VERDICT: BLOCK` when it is violated.

## Completion checklist

These five were written here as hook-enforced ("deterministic — always run"). **They are
not wired.** This repo has no `.claude/settings.json`, and `.claude/settings.local.json`
contains only permissions. Until hooks exist, run them by hand and record in
`runs/<task-id>/task-log.md` that you did:

- Post-edit: lint + typecheck touched files (`cd loop-fork && bun run check`).
- Pre-completion: test run required on any code task (`cd loop-fork && bun test`).
- On exit: append a one-paragraph entry to `runs/<task-id>/task-log.md`.
- On UI tasks: `scripts/capture-ui.sh` must succeed before eval.
- On dependency changes: `scripts/refresh-dependency-map.sh` must run.

To make them deterministic, add a project-level `.claude/settings.json` with a `hooks`
block. Do not put repo rules in the user-level settings file.

## Skills (invoke by name)

Delegate using `.claude/skills/`. Each skill is a bounded workflow invoked by name.
Background/async subagents are available via Cursor background agents or Claude Code
subagent delegation; scheduled and PR-triggered agents are declared in `.github/agents/`.

| Skill | When to use |
|---|---|
| `fix-issue` | Triaging and fixing a tracked bug |
| `ui-evaluator` | Screenshot + DOM + flow evaluation |
| `risk-review` | Pre-merge risk pass on a PR diff |

`.agents/skills/` mirrors `.claude/skills/` for non-Claude tooling. `.claude/skills/` is
canonical; the mirror is currently stale — its `risk-review` is missing the
baseline-allowlist blocking condition.

## Context engineering rules

- Pass `docs/dependency-map.md` when reasoning about cross-module impact.
- Pass `docs/quality/quality-scorecard.md` when prioritizing debt or refactoring.
- Pass the feature's `verify.md` to every evaluator agent.
- Do not stuff the 1M window. Rank and select; don't dump.

## What NOT to do

- Do not start implementation from chat. Start from `specs/<feature>/spec.md`.
- Do not merge or push to `main`. The supervisor merges.
- Do not merge a PR without an `eval.json` in `runs/<task-id>/`.
- Do not self-review. The evaluator agent is never the implementation agent.
- Do not record baseline failures as a count or a flag.
- Do not write giant prompt blobs into this file or `AGENTS.md`.

## Known drift (recorded 2026-07-27)

Written down so agents stop citing these as though they were live:

- **No hooks are configured.** See Completion checklist above.
- `docs/quality/quality-scorecard.md` and `docs/testing/commands.md` are still the
  shipped templates (`[e.g. Auth]`, `[your-unit-test-command]`, empty `Last updated`).
  Any rule that gates on a scorecard grade is unenforceable until the scorecard is real.
- `scripts/verify.sh` lint/typecheck/unit/integration steps are `[CONFIGURE]` stubs;
  `scripts/refresh-dependency-map.sh` is likewise stubbed.
- `docs/architecture/invariants.md` does not exist, yet `specs/constitution.md` names it
  as a protected path. The real invariants live in `docs/architecture/system-overview.md`.
- `evals/{smoke,regression,replay,skills}` are empty directories; `evals/README.md`
  describes a harness that has no contents yet.
- Several `specs/*/verify.md` still accept "the 4 known baseline Codex-launch failures",
  which contradicts the empty-allowlist rule that `check-baseline-allowlist.py` enforces.

## CLAUDE.md stays short

If you find yourself adding more than a paragraph here, it belongs in a skill, a spec, or
a doc instead.

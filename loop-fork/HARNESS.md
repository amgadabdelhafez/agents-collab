# Harness V2

This repository has the repo-local Harness v2 kit installed. Use it to keep task state, checkpoints, plans, verification evidence, retrospectives, and agent coordination inspectable in the repo.

## Start Or Resume

```bash
./harness status --json
./harness list --status active
./harness resume
./harness plan
```

If `status --json` shows `"active_task": null`, create a task before editing.

## Start A Task

Emergent/small task:

```bash
./harness task task-slug --description "short description"
```

Planned task:

```bash
./harness task task-slug --mode planned --description "short description"
./harness plan --init
```

Large tasks or reusable patterns should require research first:

```bash
./harness task task-slug --mode planned --estimate-loc 500 --description "short description"
./harness plan --init
./harness research --init
# Do web/open-source/library/pattern research.
./harness research --save --file /tmp/research.md
./harness research --gate
```

Use `--research-required` to force research on smaller tasks.

## During Work

```bash
./harness checkpoint "short topic"
./harness coordinate editing --file path/to/file
./harness coordination --tail 20
```

Keep `runs/<task-id>/plan.md` and `runs/<task-id>/task-log.md` current. Planned tasks fail preflight if the plan is missing or empty.

## Loop Integration

When using `loop`, do not pass a long inline `--prompt "..."` string. Inline prompt text can make loop create a root `PLAN.md`, while Harness keeps the canonical plan at `runs/<task-id>/plan.md`.

Generate a run-owned slice prompt instead:

```bash
./harness loop-prompt 02-gap-classifier \
  --slice "Implement only the next planned slice." \
  --test-command "pytest"
```

Then run the printed `loop --prompt runs/<task-id>/loop-slices/<slug>.md` command. Keep `--review-plan none` when the Harness plan is already the source of truth.

`loop-prompt` normalizes bare `pytest ...` proof commands to
`venv/bin/python -m pytest ...` or `.venv/bin/python -m pytest ...` when a
repo-local virtualenv exists. Generated prompts also remind reviewers to bump
cache/schema version constants when a slice changes cached payloads.

## Verification

Wrap the repo's normal verification command so Harness records durable evidence:

```bash
./harness verify unit -- <repo-specific test command>
./harness preflight --json
./harness stop-gate --json
```

Examples of `<repo-specific test command>` are `npm test`, `pytest`, `./scripts/verify.sh`, `swift test`, or whatever this repo already uses.

## Complete

```bash
./harness checkpoint "ready to complete"
./harness done
```

`done` requires stop-gate pass, updates `.harness/tasks.json`, generates `specs/<task-id>.md`, runs non-blocking debt/regression harvest, and clears `.harness/current-task`.

## Useful Commands

```bash
./harness help
./harness status --json
./harness list --json
./harness park "idea text" --name idea-slug
./harness promote idea-slug --mode planned
./harness audit security --path src
./harness retrospect --semantic
./harness session-export --source ~/.codex/sessions --out sessions
```

## Structured Regression Markers

Add these to `runs/<task-id>/task-log.md` when a task fixes a regression:

```markdown
Regression: yes
Regression id: stable-slug
Regression symptom: User-visible failure.
Regression guard: tests/path_or_command
```

Use `Regression: no` for meta/documentation work that mentions bug-fix or regression examples.

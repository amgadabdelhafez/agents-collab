# Loop Slice Prompt: harvto-defect-campaign

Use this file as the `loop --prompt` input. Do not pass equivalent plain text
to `loop`, because plain text makes loop create a root `PLAN.md`.

## Harness Context

- Active task: `harvto-supervisor-defects`
- Canonical Harness plan: `runs/harvto-supervisor-defects/plan.md`
- This slice prompt: `runs/harvto-supervisor-defects/loop-slices/harvto-defect-campaign.md`

## Slice Scope

Execute the full planned campaign in priority order. Start by reading the spec, tasks, verify file, Harness plan, AGENTS.md, and the read-only Harvto evidence. Reproduce before patching, record refutations, keep the defect matrix current, commit bounded fixes, and use the paired peer for exact-SHA zero-write reviews. Continue automatically through allowed corrections and Harness close gates. Do not stop at planning or ask for routine task-transition authorization.

## Agent Roles

- Codex is the primary implementer.
- Claude is the reviewer, bridge manager, and test-pressure agent.
- Harness is the source of truth for task state and evidence.

## Rules

- Read `HARNESS.md`, `runs/harvto-supervisor-defects/plan.md`, and the latest files in `runs/harvto-supervisor-defects/memory/`.
- Treat `runs/harvto-supervisor-defects/plan.md` as the canonical parent plan.
- Treat this file as the loop execution plan for this slice only.
- Do not create, replace, or rely on root `PLAN.md`.
- Keep changes scoped to the slice.
- Update `runs/harvto-supervisor-defects/task-log.md` with what changed and why.
- Add checkpoints with `./harness checkpoint "<topic>"` after meaningful decisions.
- Run `./harness preflight --json` before stopping.
- Do not run `./harness done`; this prompt is for one slice of the active task.

## Review Checks

- Prefer repo-local test interpreters. Bare `pytest` proof commands are normalized to `venv/bin/python -m pytest` or `.venv/bin/python -m pytest` when that interpreter exists.
- If this slice changes cached or schema-versioned payloads, bump the matching version constant or explicitly note why no bump is needed.

## Proof Criteria

- Run `./harness verify unit -- bun test`.

# Skill: fix-issue
> Standard workflow for triaging and fixing a tracked bug or GitHub issue.

## When to use

When assigned a bug, defect, or issue reference. Do not use for new features — use the spec flow instead.

## Steps

1. **Read the issue** and extract: symptom, reproduction steps, affected module.
2. **Read `docs/dependency-map.md`** — identify blast radius.
3. **Read `docs/quality/quality-scorecard.md`** — check health of the affected subsystem.
4. **Reproduce** the bug by running the app and triggering the symptom. Capture a screenshot or log if UI/runtime.
5. **Create a worktree**: `git worktree add ../task-<issue-id> -b fix/<issue-id>`
6. **Create `runs/<issue-id>/`** with:
   - `task-log.md` — record your understanding of the bug
   - `decisions.md` — record your fix approach and why
7. **Implement** the minimal fix. No scope creep.
8. **Write or update a test** that would have caught this bug.
9. **Run `scripts/verify.sh --task-id <issue-id>`**.
10. **Run `scripts/capture-ui.sh`** if UI was involved.
11. **Run the risk-review skill** on the diff.
12. **Write `runs/<issue-id>/eval.json`** with verdict.
13. Open PR referencing the issue.

## Definition of done

- Bug is not reproducible.
- A test exists that would catch a regression.
- `eval.json` verdict is "pass".
- Risk review verdict is LOW or MEDIUM (not BLOCK).

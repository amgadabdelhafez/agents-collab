# Background Agent: docs-gardener
> Runs on a schedule. Keeps documentation current and flags drift.

## Trigger

- Schedule: weekly (e.g. Monday 09:00 UTC)
- On-demand: can be triggered manually

## What it does

### 1. Dependency map freshness check
- Run `scripts/refresh-dependency-map.sh` in dry-run mode.
- If the map is stale (last updated > 14 days or import graph has changed), open a PR refreshing it.

### 2. Architecture doc drift check
- Compare `docs/architecture/system-overview.md` against the current service list in `docs/dependency-map.md`.
- If a service exists in the map but is missing from the overview, open an issue: "docs: system-overview missing [service]".

### 3. Quality scorecard refresh
- Re-run test coverage and update grades in `docs/quality/quality-scorecard.md`.
- If any subsystem drops a letter grade, open a PR with the updated scorecard and an issue tagged `quality-regression`.

### 4. Stale spec detection
- Find `specs/*/spec.md` files whose feature has been fully merged (all tasks done) but no `verify.md` or `eval.json` exists.
- Open an issue: "eval gap: [feature] shipped without eval harness".

### 5. Dead-code scan (optional, configure threshold)
- Run dead-code analysis.
- If unreferenced exports exceed threshold (e.g. 50 new items), open a PR or issue.

## Output

Each finding becomes either:
- A PR (for auto-fixable things like map refresh, scorecard update)
- An issue (for things requiring human or agent follow-up)

PRs opened by this agent use the commit message:
```
chore: [description] [docs-gardener]

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Notes

- This agent does NOT touch application code.
- Limit to 3 open PRs/issues at a time to avoid noise.

# Background Agent: architecture-review
> Runs after significant merges or on a schedule.
> Grades subsystem health and updates quality-scorecard.md.

## Trigger

- Schedule: monthly
- After merge: any PR touching `docs/architecture/` or adding a new service

## What it does

1. For each subsystem in `docs/quality/quality-scorecard.md`:
   - Run test coverage report → update Coverage column.
   - Check observability config → update Observability column.
   - Count open P1/P2 issues → update Defects column.
   - Check for eval harness existence in `evals/` → update Eval harness column.
   - Recalculate grade using the rubric in quality-scorecard.md.

2. If any grade changed:
   - Open a PR updating `docs/quality/quality-scorecard.md`.
   - PR body lists every grade change with direction (↑ improved / ↓ regressed).

3. If any subsystem drops to D or F:
   - Open a separate issue: "architecture: [subsystem] degraded to [grade]"
   - Tag: `quality-regression`, `needs-spec`
   - Assign to the subsystem owner if listed.

4. Check for new subsystems in `docs/dependency-map.md` not yet in the scorecard:
   - Add them with grade "?" and open an issue to grade them.

## Notes

- Does NOT modify application code.
- Uses the rubric in `docs/quality/quality-scorecard.md` verbatim. Do not invent criteria.
- If coverage tooling is unavailable, mark the cell `[unknown]` rather than omitting it.

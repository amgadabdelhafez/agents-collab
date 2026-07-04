# Background Agent: risk-review
> Runs on every PR opened against main/trunk.
> Produces a structured risk assessment as a PR comment.

## Trigger

- On: `pull_request` (opened, synchronize)
- Branches: `main`, `trunk`, `release/*`

## Inputs

- PR diff
- `docs/dependency-map.md`
- `docs/quality/quality-scorecard.md`
- The `runs/<task-id>/eval.json` if it exists (look for task-id in PR description)

## Behavior

1. Run the `risk-review` skill (`.claude/skills/risk-review/skill.md`).
2. Post the output as a PR review comment.
3. If verdict is BLOCK: request changes (do not approve).
4. If verdict is HIGH: add label `risk:high` and tag the PR author.
5. If verdict is LOW or MEDIUM: approve automatically.

## Notes

- This agent does NOT merge PRs. It only reviews.
- Verdict BLOCK does not auto-close the PR. It blocks auto-merge.
- The agent should NOT modify source files. Read-only except for the PR comment.

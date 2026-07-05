# Skill: risk-review
> Pre-merge risk pass on a PR diff.
> Invoke before any PR is opened. Produces a structured risk assessment.

## When to use

Every PR. Invoked automatically by the risk-review background agent (`.github/agents/risk-review.agent.md`),
or manually when a task finishes implementation.

## Inputs

- PR diff (or `git diff main..HEAD`)
- `docs/dependency-map.md`
- `docs/quality/quality-scorecard.md`
- `specs/<feature>/verify.md`

## Steps

1. Read the diff. Identify all changed files and modules.
2. Cross-reference with `docs/dependency-map.md`:
   - Which downstream services/modules consume what was changed?
   - Does any change touch a "blast-radius" row in the dependency map?
3. Cross-reference with `docs/quality/quality-scorecard.md`:
   - Is the touched subsystem graded C, D, or F? Flag it.
4. Check for:
   - New external I/O without trace spans.
   - Credentials or secrets in code.
   - Schema migrations without backward compatibility.
   - Missing tests for new code paths.
   - Changes to protected paths without an approved spec.
5. Write the risk assessment to stdout in the format below.

## Output format

```
RISK REVIEW — <PR title or task-id>
Date: <ISO-8601>

VERDICT: LOW | MEDIUM | HIGH | BLOCK

Findings:
- [SEVERITY] [File/module]: [Description of risk]
- ...

Blast radius:
- [Downstream module/service] affected by changes to [what]

Recommended actions:
- [Action 1]
- [Action 2]

Notes: [Any context]
```

## Blocking conditions (VERDICT: BLOCK)

Set verdict to BLOCK if any of the following are true:
- Credentials or secrets found in diff.
- Protected path modified without spec reference.
- Touched subsystem is grade F with no remediation spec.
- Missing eval.json in `runs/<task-id>/`.

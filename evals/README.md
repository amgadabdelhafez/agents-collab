# Evals

This directory contains the evaluation harnesses for this repo.

## Structure

```
evals/
  smoke/      — Fast checks that the app boots and core flows work
  regression/ — Checks that previously-passing behaviors still pass
  replay/     — Replays of real incidents/bugs used as regression tests
  skills/     — Evals that verify agent skills work correctly
```

## Philosophy

> No workflow is "advanced" until it has a replayable eval.

The 89%/52% gap (LangChain 2026): almost all teams have observability, but less than
half have formal evals. Observability tells you *that* something failed. Evals tell you
*whether* your changes made things better or worse, before they reach production.

## Adding an eval

1. **Smoke:** Add a script to `evals/smoke/` that exits 0 on pass. Run in CI on every PR.
2. **Regression:** When a bug is fixed, add a test to `evals/regression/` that would have caught it.
3. **Replay:** When a production incident occurs, capture the state and add a replay to `evals/replay/`.
4. **Skill:** When a new agent skill is added, add a workflow test to `evals/skills/`.

## Replay eval format

A replay eval in `evals/replay/` contains:
- `incident.md` — Description of the original incident
- `setup.sh` — Script to recreate the state that caused the incident
- `check.sh` — Script that exits 0 if the incident would be caught/prevented
- `golden/` — Expected outputs or screenshots

## Running evals

```bash
# Smoke (fast, run on every PR)
bash evals/smoke/*.sh

# Full regression suite
bash evals/regression/*.sh

# Replay suite (run before significant releases)
bash evals/replay/*/check.sh

# Skill evals
bash evals/skills/*.sh
```

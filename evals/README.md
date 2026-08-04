# Evals

## Smoke-instrument regression rule

Launcher smoke tests must derive the expected reserved run id from the isolated
fixture state and exercise realistic prompt size and shipped pane topology. A
small prompt, a stale named `LOOP_RUN_ID`, or old pane geometry can make the
instrument green while the changed binary is broken. Delivery assertions must
observe an actual doorbell plus a durable notified row and reject false
delivered rows.

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

## Fixture provenance

A fixture that stands in for another component's or process's output may certify
that integration seam only when it derives from a real producer capture. Keep a
small adjacent provenance record containing:

- producer name and exact version or build identifier;
- capture command, UTC capture time, and relevant environment such as terminal
  geometry or protocol version;
- the checked-in raw bytes, or a durable raw-artifact reference plus SHA-256 when
  raw output cannot be committed safely;
- the checked-in deterministic normalization command or transform and the
  normalized fixture's SHA-256.

Sanitize secrets, credentials, tokens, personal data, and machine-specific paths
before committing any capture. If sanitization changes bytes, retain the hash and
location of the access-controlled raw source plus a reviewable normalization map;
never place sensitive raw output in Git merely to satisfy this rule.

Hand-authored inputs remain useful for isolated unit behavior. Label them
`synthetic` in the fixture or adjacent metadata. Synthetic fixtures cannot by
themselves certify a cross-component/process seam, a real producer's wire shape,
or a release smoke that claims such coverage.

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

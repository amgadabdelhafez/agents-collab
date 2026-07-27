# Regression Eval: nanny-empty-inspection-band

Generated: 2026-07-27T23:06:26Z
Source task: `nanny-bounded-inspection`
Status: draft

## Failure Symptom

- Nanny shows advisory calls but receives zero utility jobs.

## Guard Evidence

- tests/loop/utility-execution-tier.test.ts

## Verification Artifacts

- `live-runtime`: `runs/nanny-bounded-inspection/artifacts/live-runtime/loop-56.md` (pass)
- `unit`: `runs/nanny-bounded-inspection/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: nanny-empty-inspection-band
Regression symptom: Nanny shows advisory calls but receives zero utility jobs.
Regression guard: tests/loop/utility-execution-tier.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

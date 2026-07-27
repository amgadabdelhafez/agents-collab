# Regression Eval: babysitter-repeat-compact-on-limit-snapshot-flap

Generated: 2026-07-19T20:33:58Z
Source task: `babysitter-no-repeat-compact`
Status: draft

## Failure Symptom

- Babysitter repeatedly injects `/compact` and interrupts the active loop agent.

## Guard Evidence

- tests/loop/babysitter.test.ts

## Verification Artifacts

- `unit`: `runs/babysitter-no-repeat-compact/artifacts/unit/verify.log` (pass)

## Source Task Notes

- Focused proof: 42 tests passed.
- Full proof: 562 tests passed; compiled executable built successfully.
- Broad `bun run check` remains red on existing repository-wide Ultracite
  findings, including unrelated source files and generated Harness JSON.
- Live proof after respawn: the babysitter PID changed to 67893, its persisted
  tick advanced, and no new `limit-restore` or `limit-handoff` record appeared.

Regression: yes
Regression id: babysitter-repeat-compact-on-limit-snapshot-flap
Regression symptom: Babysitter repeatedly injects `/compact` and interrupts the active loop agent.
Regression guard: tests/loop/babysitter.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

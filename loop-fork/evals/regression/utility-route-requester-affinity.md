# Regression Eval: utility-route-requester-affinity

Generated: 2026-07-28T02:02:34Z
Source task: `loop57-au-pair-recovery`
Status: active

## Failure Symptom

- Codex-originated fallback results were delivered to Claude.

## Guard Evidence

- tests/loop/utility-runtime.test.ts

## Verification Artifacts

- `build`: `runs/loop57-au-pair-recovery/artifacts/build/verify.log` (pass)
- `focused`: `runs/loop57-au-pair-recovery/artifacts/focused/verify.log` (pass)
- `full`: `runs/loop57-au-pair-recovery/artifacts/full/verify.log` (pass)
- `unit`: `runs/loop57-au-pair-recovery/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: utility-route-requester-affinity
Regression symptom: Codex-originated fallback results were delivered to Claude.
Regression guard: tests/loop/utility-runtime.test.ts

## Execution

The requester-affinity cases execute in `tests/loop/utility-runtime.test.ts`
and are included in both the focused and full Harness verification dimensions.

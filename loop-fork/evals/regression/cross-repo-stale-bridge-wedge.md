# Regression Eval: cross-repo-stale-bridge-wedge

Generated: 2026-07-29T19:48:42Z
Source task: `cross-repo-stale-bridge-sweep`
Status: draft

## Failure Symptom

- Old bridge MCP children can issue unbounded tmux probes and wedge new launches.

## Guard Evidence

- tests/loop/run-process-cleanup.test.ts and tests/loop.test.ts

## Verification Artifacts

- `unit`: `runs/cross-repo-stale-bridge-sweep/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: cross-repo-stale-bridge-wedge
Regression symptom: Old bridge MCP children can issue unbounded tmux probes and wedge new launches.
Regression guard: tests/loop/run-process-cleanup.test.ts and tests/loop.test.ts

Live run 100 is read-only. No process was signaled during investigation.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

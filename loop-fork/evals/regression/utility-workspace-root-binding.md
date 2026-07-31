# Regression Eval: utility-workspace-root-binding

Generated: 2026-07-31T04:18:27Z
Source task: `utility-workspace-root-binding`
Status: draft

## Failure Symptom

- Helper edit packets reject or read missing files when the driver works in a linked worktree and submits repo-relative scopes.

## Guard Evidence

- tests/loop/utility-workspace.test.ts plus bridge and utility-tools focused tests

## Verification Artifacts

- `build`: `runs/utility-workspace-root-binding/artifacts/build/verify.log` (pass)
- `focused`: `runs/utility-workspace-root-binding/artifacts/focused/verify.log` (pass)
- `full`: `runs/utility-workspace-root-binding/artifacts/full/verify.log` (pass)
- `static`: `runs/utility-workspace-root-binding/artifacts/static/verify.log` (pass)
- `unit`: `runs/utility-workspace-root-binding/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: utility-workspace-root-binding
Regression symptom: Helper edit packets reject or read missing files when the driver works in a linked worktree and submits repo-relative scopes.
Regression guard: tests/loop/utility-workspace.test.ts plus bridge and utility-tools focused tests

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

# Regression Eval: recon-pane-width-followup

Generated: 2026-07-28T02:49:37Z
Source task: `recon-pane-width-followup`
Status: active

## Failure Symptom

- The tools pane still consumed space needed by route objectives after its
  rows were compacted.

## Guard Evidence

- tests/loop/tmux.test.ts

## Verification Artifacts

- `build`: `runs/recon-pane-width-followup/artifacts/build/verify.log` (pass)
- `unit`: `runs/recon-pane-width-followup/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: recon-pane-width-followup
Regression symptom: The tools pane still consumed space needed by route
objectives after its rows were compacted.
Regression guard: tests/loop/tmux.test.ts

## Execution

`tests/loop/tmux.test.ts` asserts the 49% remainder split and 68% result split,
which produce the intended approximately 51/15/34 pane widths.

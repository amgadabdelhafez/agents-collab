# Regression Eval: semantic-recon-pane-labels

Generated: 2026-07-28T02:26:15Z
Source task: `recon-pane-labels`
Status: active

## Failure Symptom

- Recon pane numbers did not explain their contents.

## Guard Evidence

- tests/loop/tmux.test.ts

## Verification Artifacts

- `build`: `runs/recon-pane-labels/artifacts/build/verify.log` (pass)
- `unit`: `runs/recon-pane-labels/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: semantic-recon-pane-labels
Regression symptom: Recon pane numbers did not explain their contents.
Regression guard: tests/loop/tmux.test.ts

## Execution

`tests/loop/tmux.test.ts` asserts all three semantic pane labels and runs in
the Harness `unit` verification dimension.

# Regression Eval: governess-pane-generic-title

Generated: 2026-07-25T22:29:10Z
Source task: `governess-pane-identity`
Status: draft

## Failure Symptom

- The governess pane is labeled generically and its native tmux title is the host name, hiding the loop identity and path.

## Guard Evidence

- tests/loop/governess.test.ts

## Verification Artifacts

- `unit`: `runs/governess-pane-identity/artifacts/unit/verify.log` (pass)

## Source Task Notes

_No notes recorded._

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

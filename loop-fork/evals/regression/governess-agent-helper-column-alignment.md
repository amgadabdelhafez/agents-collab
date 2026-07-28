# Regression Eval: governess-agent-helper-column-alignment

Generated: 2026-07-28T03:13:11Z
Source task: `governess-column-alignment`
Status: active

## Failure Symptom

- Main-agent and helper token/tool columns did not share a visual grid.

## Guard Evidence

- tests/loop/governess.test.ts

## Verification Artifacts

- `unit`: `runs/governess-column-alignment/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governess-agent-helper-column-alignment
Regression symptom: Main-agent and helper token/tool columns did not share a
visual grid.
Regression guard: tests/loop/governess.test.ts

## Execution

`tests/loop/governess.test.ts` compares the visible character offsets of the
main/helper token headers and the main activity/helper tool headers. It also
checks that every rendered board line stays within the supported viewport.

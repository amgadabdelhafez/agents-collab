# Regression Eval: compact-recon-pane-signal

Generated: 2026-07-28T02:36:12Z
Source task: `recon-pane-signal-density`
Status: active

## Failure Symptom

- Recon dashboards repeated IDs, wrappers, duplicate calls, and whole refresh
  frames.

## Guard Evidence

- tests/loop/recon-pane.test.ts

## Verification Artifacts

- `build`: `runs/recon-pane-signal-density/artifacts/build/verify.log` (pass)
- `unit`: `runs/recon-pane-signal-density/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: compact-recon-pane-signal
Regression symptom: Recon dashboards repeated IDs, wrappers, duplicate calls,
and whole refresh frames.
Regression guard: tests/loop/recon-pane.test.ts

## Execution

`tests/loop/recon-pane.test.ts` asserts compact route rows, grouped tool calls,
human-readable result extraction, and pending/completed deduplication. The
three-pane width split is asserted by `tests/loop/tmux.test.ts`; both run in the
Harness `unit` verification dimension.

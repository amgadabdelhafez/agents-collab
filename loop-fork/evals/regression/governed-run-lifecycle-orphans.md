# Regression Eval: governed-run-lifecycle-orphans

Generated: 2026-07-29T06:26:50Z
Source task: `run-lifecycle-teardown`
Status: draft

## Failure Symptom

- Teardown left bridge MCP processes and port 4500 owned by a detached app-server; bootstrap could remain before pane creation.

## Guard Evidence

- tests/loop/run-process-cleanup.test.ts and tests/loop/tmux.test.ts

## Verification Artifacts

- `unit`: `runs/run-lifecycle-teardown/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governed-run-lifecycle-orphans
Regression symptom: Teardown left bridge MCP processes and port 4500 owned by a detached app-server; bootstrap could remain before pane creation.
Regression guard: tests/loop/run-process-cleanup.test.ts and tests/loop/tmux.test.ts

Live smoke `lifecycle-smoke-1` started a full promptless governed workspace in
3.3 seconds. Its manifest recorded app-server PID 41453 on port 4500. Explicit
Governess teardown logged `killed:[41559,41473,41453]`, removed the tmux
session, freed port 4500, and left ChatGPT desktop app-server PID 44149 alive.

Full suite: 1185 pass, 0 fail. `bun run check` passes.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

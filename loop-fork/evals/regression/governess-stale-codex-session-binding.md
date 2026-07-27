# Regression Eval: governess-stale-codex-session-binding

Generated: 2026-07-27T04:41:04Z
Source task: `governess-codex-usage-refresh`
Status: draft

## Failure Symptom

- Codex quota and lifecycle populate while model, context, tokens, cost, and activity stay blank.

## Guard Evidence

- bun test tests/loop/governess-usage.test.ts tests/loop/governess.test.ts

## Verification Artifacts

- `integration`: `runs/governess-codex-usage-refresh/artifacts/integration/verify.log` (pass)
- `unit`: `runs/governess-codex-usage-refresh/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: governess-stale-codex-session-binding
Regression symptom: Codex quota and lifecycle populate while model, context, tokens, cost, and activity stay blank.
Regression guard: bun test tests/loop/governess-usage.test.ts tests/loop/governess.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

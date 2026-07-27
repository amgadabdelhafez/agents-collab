# Task governess-codex-usage-refresh

Created: 2026-07-27T04:26:12Z
Mode: planned
Description: Refresh governess transcript bindings when Codex session IDs appear or change

## What I changed

- Refresh non-empty Claude and Codex manifest bindings before each usage tick.
- Preserve the last known binding when the manifest is absent, malformed, or
  temporarily contains an empty identifier.
- Add direct and run-loop regression coverage.

## Why

Run 50 had a valid Codex rollout and manifest thread ID, but its long-running
governess retained an empty startup binding, leaving transcript metrics blank.

## Notes

Regression: yes
Regression id: governess-stale-codex-session-binding
Regression symptom: Codex quota and lifecycle populate while model, context, tokens, cost, and activity stay blank.
Regression guard: bun test tests/loop/governess-usage.test.ts tests/loop/governess.test.ts

## Verification

- Focused governess suites: 80 pass, 0 fail.
- Full suite: 827 pass, 4 unrelated failures reproduced at base `d83f676`.
- Build: 70 modules compiled successfully.
- Independent evaluator: PASS, no blocking findings.
- Live run 50: full Codex telemetry restored; Claude, Codex, and worker PIDs
  preserved; governess doctor healthy.

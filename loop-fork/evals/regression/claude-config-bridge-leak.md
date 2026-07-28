# Regression Eval: claude-config-bridge-leak

Generated: 2026-07-28T05:05:12Z
Source task: `claude-config-bridge-gc`
Status: draft

## Failure Symptom

- governess smoke runs register loop MCP servers and sessions in the real Claude home config

## Guard Evidence

- tests/loop/claude-config-gc.test.ts, tests/loop/tmux.test.ts, tests/setup.ts

## Verification Artifacts

- `unit`: `runs/claude-config-bridge-gc/artifacts/unit/verify.log` (pass)

## Source Task Notes

- Live dry audit: `{ "failed": 0, "kept": 1, "removed": 0, "scanned": 1 }`.
- Active registry after cleanup: 28 projects, zero governess-e2e project keys,
  one loop bridge (`loop-bridge-harvto-57`).
- Focused regression suite: 70 passed, 0 failed.
- Full suite: 897 passed, 0 failed; compiled build passed.
- New/config-specific files pass Ultracite. Repository-wide `bun run check`
  still reports the pre-existing baseline of 205 diagnostics, chiefly old run
  artifacts; unrelated formatting was not rewritten.
- Already-running Claude processes retain MCP configs loaded in their argv.
  They were deliberately not killed or restarted; a normal Claude restart is
  required to shed those already-loaded tools.

Regression: yes
Regression id: claude-config-bridge-leak
Regression symptom: governess smoke runs register loop MCP servers and sessions in the real Claude home config
Regression guard: tests/loop/claude-config-gc.test.ts, tests/loop/tmux.test.ts, tests/setup.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

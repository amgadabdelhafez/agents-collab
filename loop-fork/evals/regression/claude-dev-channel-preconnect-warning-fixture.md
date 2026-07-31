# Regression Eval: claude-dev-channel-preconnect-warning-fixture

Generated: 2026-07-31T06:43:54Z
Source task: `claude-warning-producer-fixture`
Status: draft

## Failure Symptom

- A valid development-channel MCP server is reported missing during Claude startup before the bridge becomes available.

## Guard Evidence

- bun run test:file -- tests/loop/tmux.test.ts

## Verification Artifacts

- `build`: `runs/claude-warning-producer-fixture/artifacts/build/verify.log` (pass)
- `focused`: `runs/claude-warning-producer-fixture/artifacts/focused/verify.log` (pass)
- `full`: `runs/claude-warning-producer-fixture/artifacts/full/verify.log` (pass)
- `provenance`: `runs/claude-warning-producer-fixture/artifacts/provenance/verify.log` (pass)
- `release`: `runs/claude-warning-producer-fixture/artifacts/release/verify.log` (pass)
- `unit`: `runs/claude-warning-producer-fixture/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: claude-dev-channel-preconnect-warning-fixture
Regression symptom: A valid development-channel MCP server is reported missing during Claude startup before the bridge becomes available.
Regression guard: bun run test:file -- tests/loop/tmux.test.ts

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

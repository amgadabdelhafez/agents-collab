# Regression Eval: claude-channel-false-delivery-after-session-transition

Generated: 2026-07-26T04:46:33Z
Source task: `claude-bridge-visible-tui`
Status: draft

## Failure Symptom

- Claude misses bridge rulings while the ledger reports delivery.

## Guard Evidence

- tests/loop/bridge.test.ts

## Verification Artifacts

- `unit`: `runs/claude-bridge-visible-tui/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: claude-channel-false-delivery-after-session-transition
Regression symptom: Claude misses bridge rulings while the ledger reports delivery.
Regression guard: tests/loop/bridge.test.ts

- Focused bridge suite: 56 pass, 0 fail.
- Full suite: 613 pass, 4 unrelated Codex config expectation failures.
- Build and `git diff --check`: pass.
- `bun run check`: unavailable because `ultracite` is not installed.
- Live request `6054874c-2365-4a03-8572-8c74e4952a82` was visibly submitted
  to Claude and acknowledged once as `sent to claude tmux pane`.
- Claude returned `LIVE-CLAUDE-VISIBLE-CANARY-RUN38-OK` as message
  `bfcd8df0-7a04-439e-8e8a-40335825d6cf`; Codex visibly received it and the
  ledger acknowledged it as `submitted through visible codex tmux pane`.
- Claude and Codex pending counts were both zero after the canary.

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.

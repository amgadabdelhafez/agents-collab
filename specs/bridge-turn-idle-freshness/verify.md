# Verify — Bridge Turn-Idle Freshness

Run from the repo root (loop-fork).

## Commands

1. `bun test tests/loop/bridge.test.ts` — all pass, including:
   - "isClaudeTurnActive treats a fresh failed tail as active" (matrix test)
   - fresh `failed` delivery regression (blocks injection, message pending)
   - stale `starting` resume-wedge regression (delivers to idle pane)
   - the pre-existing fresh-`working` regression still passes.
2. `bun run check` — no lint/type errors.
3. `bun test` — only the 4 known Codex-launch baseline failures
   (tests that spawn a real `codex` binary); no new failures.

## Behavior checks

- `isClaudeTurnActive` returns **true** for journal tails (with mocked
  `bridgeRuntimeCommandDeps.now` pinned near the fixture `ts`):
  - `{state:"working"}` fresh; `{state:"starting"}` fresh;
    `{event:"PostToolUse", state:"failed"}` fresh (defect 1);
  - an active-state tail with no `ts` (fail-closed).
- `isClaudeTurnActive` returns **false** for:
  - `{state:"starting"}` older than 30s (defect 2, resume wedge);
  - `{state:"working"}` / `{state:"failed"}` older than 5 minutes;
  - `{event:"Stop", state:"input-required"}` at any age.
- Delivery path: with a stale `starting` tail and an empty composer,
  `deliverTmuxBridgeMessage` types the message and consumes it from the
  pending inbox; with a fresh `failed` tail it sends no keys and leaves the
  message pending.

## Out of scope

- `hooks/emit.ts` lifecycle mapping (unchanged by design).
- Live tmux end-to-end runs (covered by mocked spawnSync fixtures).

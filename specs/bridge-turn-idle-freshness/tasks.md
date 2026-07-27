# Tasks — Bridge Turn-Idle Freshness

1. [x] RED: add failing tests to tests/loop/bridge.test.ts
   - unit matrix for `isClaudeTurnActive` (mock `bridgeRuntimeCommandDeps.now`):
     fresh `failed` → active; stale `failed` → inactive; fresh `starting` →
     active; stale `starting` → inactive; stale `working` → inactive;
     missing `ts` on an active-state tail → active.
   - delivery regression: fresh `failed` tail blocks injection (no
     send-keys, message stays pending).
   - delivery regression: stale `starting` tail (resume wedge) delivers to an
     idle pane.
   - Run `bun test tests/loop/bridge.test.ts`, confirm each new test fails
     for the expected reason.
2. [x] GREEN: implement in src/loop/bridge-runtime.ts
   - add `CLAUDE_TURN_STARTING_STALE_MS` / `CLAUDE_TURN_WORKING_STALE_MS`,
   - add `now` to `bridgeRuntimeCommandDeps`,
   - rewrite `isClaudeTurnActive` per the decision table in plan.md.
3. [x] Pin the existing "does not inject into an active turn" fixture to the
   mock clock so it stays a fresh-`working` regression.
4. [x] Verify: `bun test tests/loop/bridge.test.ts`, `bun run check`,
   full `bun test` (baseline: 4 known Codex-launch failures).
5. [x] Harness: checkpoint decision, `./harness verify unit`, `./harness done`;
   check off spec acceptance criteria; append run log entry.

# Verification

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun test
bun run build
git diff --check
```

Live acceptance: with a dim type-ahead suggestion visible in the idle Claude
composer, the pending Codex message is injected once (one new `delivered`
ledger record, no duplicates); while a real (non-dim) draft blocks delivery,
the head message stays visible to `receive_messages` (no fresh claim file
during the wait); Claude, Codex, governess, and utility-pane PIDs unchanged —
only the dedicated bridge worker restarts.

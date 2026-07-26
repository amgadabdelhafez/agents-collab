# Verify: Claude Pane Delivery Confirmation

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun test tests/loop/bridge*.test.ts tests/loop/governess*.test.ts
bun test
bun run build
```

Live acceptance records Claude/Codex pane IDs and PIDs before and after the
lower-control refresh, then confirms pending codex-to-Claude ledger traffic is
not acknowledged without transcript-backed submission proof.

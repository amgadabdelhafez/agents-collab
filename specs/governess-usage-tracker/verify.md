# Verify: Governess Usage Tracker Contract

```bash
cd loop-fork
bun test tests/loop/governess-usage-limits.test.ts
bun test tests/loop/governess-usage.test.ts tests/loop/governess.test.ts
bun test tests/loop/governess*.test.ts tests/loop/tmux.test.ts
bun run build
git diff --check
```

## Live

1. Record Claude, Codex, and governess pane PIDs.
2. Respawn only the governess pane with the verified binary.
3. Compare displayed aggregate limits and resets to authenticated `/stats`.
4. Confirm non-zero estimated run value for supported current models.
5. Confirm header/rows remain within 180 visible columns.
6. Run governess doctor/replay and confirm both agent PIDs are unchanged.

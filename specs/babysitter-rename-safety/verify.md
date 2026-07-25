# Verify: Babysitter Rename Safety

## Automated checks

```bash
cd loop-fork
bun test tests/loop/babysitter.test.ts
bun test
bun run build
```

## Functional checks

- Default config produces no `/rename` text or Enter key sends.
- Explicit opt-in produces the legacy rename command.
- Pane-border label tests remain green.
- Only the active babysitter pane is respawned.
- The persisted tick advances after restart and `paneRenames` remains unchanged
  across at least one pane-label refresh interval.

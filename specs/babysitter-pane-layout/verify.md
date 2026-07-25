# Verify: Babysitter Pane Layout Cleanup

```bash
cd loop-fork
bun test tests/loop/babysitter.test.ts --test-name-pattern 'board|summary'
bun run build
```

Live verification must capture `harvto-loop-33:0.2`, show the full Project
line, show separate runtime/activity headers with no accidental wraps, preserve
the two agent PIDs, and advance the persisted babysitter tick.

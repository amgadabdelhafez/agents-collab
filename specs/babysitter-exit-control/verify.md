# Verify: Babysitter Exit Control

## Automated

```bash
cd loop-fork
bun test tests/loop/babysitter-exit.test.ts
LOOP_BABYSIT_LIMIT_HANDOFF=1 bun test tests/loop/babysitter.test.ts
bun run build
```

## Live, non-destructive

1. Rebuild and respawn only `harvto-loop-33:0.2`.
2. Confirm Claude and Codex PIDs are unchanged and state ticks advance.
3. Press `x`; confirm the top row becomes the `e`/`h`/cancel menu.
4. Press `c`; confirm the regular board returns.
5. Confirm no bridge message, TUI text, session kill, replacement launch, or
   persisted handover state was produced by the open/cancel check.

Destructive `e` and `h` behavior is covered with injected integration tests,
not exercised on the active user loop during deployment.

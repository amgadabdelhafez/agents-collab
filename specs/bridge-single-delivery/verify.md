# Verification

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun test
bun run build
git diff --check
```

Live acceptance requires no new event or pane injection for the resolved loop-48
bridge ID, successful delivery of later distinct IDs, and unchanged Claude,
Codex, governess, and worker-pane PIDs except for the dedicated bridge worker.

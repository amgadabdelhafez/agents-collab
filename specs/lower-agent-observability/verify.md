# Verify: Lower-Agent Observability

```bash
cd loop-fork
bun test tests/loop/utility-runtime.test.ts tests/loop/governess.test.ts
bun test tests/loop/utility-*.test.ts tests/loop/governess*.test.ts \
  tests/loop/bridge.test.ts tests/loop/tmux.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Live release evidence:

- Record all loop-46 pane IDs, PIDs, commands, and current output before release.
- Refresh only the lower-agent and governess display panes if the session is
  still live and their commands can be reconstructed exactly.
- Confirm Claude and Codex pane IDs/PIDs are unchanged and both display panes
  advance using the installed binary.

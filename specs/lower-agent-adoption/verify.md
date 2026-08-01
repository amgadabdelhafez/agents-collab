# Verify: Lower-Agent Delegation Adoption

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts \
  tests/loop/governess-hooks.test.ts \
  tests/loop/codex-tmux-proxy.test.ts \
  tests/loop/bridge.test.ts \
  tests/loop/utility-runtime.test.ts \
  tests/loop/tmux.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh --task-id <task-id>
```

Additional release evidence:

- `runs/lower-agent-adoption/eval.json` is authored by an evaluator other than
  the implementation agent.
- Before/after snapshots of loop-45 tmux pane IDs and PIDs are identical.
- The shell-resolved `loop` entrypoint points to the newly built canonical
  binary only after all checks and evaluation pass.

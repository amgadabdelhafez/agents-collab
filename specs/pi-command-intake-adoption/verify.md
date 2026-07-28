# Verification

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts \
  tests/loop/task-router.test.ts \
  tests/loop/utility-workspace.test.ts \
  tests/loop/utility-execution-tier.test.ts \
  tests/loop/utility-runtime.test.ts \
  tests/loop/utility-tools.test.ts \
  tests/loop/governess-hooks.test.ts \
  tests/loop/tmux.test.ts \
  tests/loop/bridge.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Additional gates:

- Replay Loop 56 without emitting raw command or prompt text.
- Assert fully exact mixed plans make zero model calls.
- Assert every plan stage exposes exactly one broker tool and cannot cross into
  another stage's cwd, argv, read scope, or output boundary.
- Assert mutation, remote, heredoc, interpreter, substitution, loop, redirect,
  and unverified-workspace fixtures remain rejected.
- Assert Claude and Codex prompts, Claude channel instructions, and route-task
  description all contain the adoption contract.
- Capture independent evaluation in `runs/pi-command-intake-adoption/eval.json`.
- Before/after live snapshots must preserve Claude and Codex pane IDs/PIDs.

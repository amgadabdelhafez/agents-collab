# Verification

```bash
cd loop-fork
bun test tests/loop/recon-pane.test.ts tests/loop/tmux.test.ts \
  tests/loop/governess.test.ts tests/loop/utility-runtime.test.ts
bun run test:ci
bun run build
git diff --check
```

Live acceptance:

- `harvto-loop-59` contains purpose-named recon panes below the existing panes.
- Claude and Codex retain their original pane IDs and PIDs.
- The T4 batch is allowed to progress and finish naturally without a forced restart.
- Governess and helper panes use the integrated binary and continue repainting.

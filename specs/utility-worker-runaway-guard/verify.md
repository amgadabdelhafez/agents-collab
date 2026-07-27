# Verification

```bash
cd loop-fork
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts
bun test
bun run build
git diff --check
../scripts/verify.sh utility-worker-runaway-guard utility-worker-runaway-guard
```

Live acceptance installs the verified binary without restarting any loop-53
pane, preserves all pane PIDs, and leaves `loop governess doctor 53` green.

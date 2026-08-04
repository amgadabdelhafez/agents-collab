# Verify: Manifest Teardown Reconciliation

```bash
cd loop-fork
bun test tests/loop/codex-tmux-proxy.test.ts
bun run build
cd ..
scripts/verify.sh
git diff --check
```

The focused suite must prove that only affirmative dead-session evidence can
change an active manifest, and that topology/state changes observed during the
atomic update are preserved.

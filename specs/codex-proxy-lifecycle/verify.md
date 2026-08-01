# Verify: Codex Proxy Lifecycle Hardening

```bash
cd loop-fork
bun test tests/loop/ws-client.test.ts \
  tests/loop/codex-tmux-proxy.test.ts \
  tests/loop/codex-tmux-proxy.integration.test.ts
bun test tests/loop/codex-app-server.test.ts tests/loop/tmux.test.ts \
  tests/loop/bridge.test.ts
bun run check
npm run test:ci
bun run build
git diff --check
```

Release-only evidence, not authorized by this task:

- Integrate onto the supervisor-owned release lineage containing deployed T07,
  the corrected baseline gate, current origin/main, and bridge-overflow work.
- Re-run the full commands above on the exact integrated SHA.
- Build an immutable candidate binary and run the liaison section-4
  changed-binary live-launch smoke with a realistic prompt.
- Confirm the smoke proxy lifecycle journal contains `started`, remains on the
  same TUI socket across a forced upstream restart, and records no unexplained
  stop before teardown.

# Verification

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun test tests/loop/codex-tmux-proxy.test.ts
bun test
bun run build
git diff --check
```

Full-suite baseline: 4 known Codex-launch failures (loop-scoped Codex home /
persistent thread launch tests); anything beyond those is a regression.

Unit acceptance: while `injectCodexMessage` is in flight the message's claim
file exists and `receive_messages` filtering would skip it; a failed injection
releases the claim and leaves the message pending; a message consumed before
injection is never injected; a fresh foreign claim makes delivery yield; codex
pane delivery under the visible ack reason holds the claim during send-keys
and records "submitted through visible codex tmux pane" in the delivered
ledger record.

Live acceptance: only the dedicated `__bridge-worker` restarts on the rebuilt
binary; Claude, Codex, governess, and utility-pane PIDs unchanged; no
duplicate `delivered` ledger records for any message delivered after the
restart.

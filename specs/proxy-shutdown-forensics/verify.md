# Verification

- `bun test tests/loop/codex-tmux-proxy.test.ts tests/loop/tmux.test.ts`
- `bun test`
- `bun run build`
- `git diff --check`
- `scripts/verify.sh proxy-shutdown-forensics feature`

The producer-backed assertion must start a real loopback proxy, call the actual
shutdown client, and read the durable lifecycle JSONL.

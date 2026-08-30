# Verify: compiled orchestration worker

- `bun run test:file -- tests/loop/temporal-supervisor-runtime.test.ts`
- `bun run test:file -- tests/loop/loop-orchestration-server.test.ts`
- Build the committed binary and start an isolated orchestration server with
  `TEMPORAL_DEBUG` absent; `/healthz` must return `state=ready`.
- `bun run test:ci`
- `bun run check`
- `bun run build`
- `git diff --check`
- Every named failure set is empty.


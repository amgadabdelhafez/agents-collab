# Verify: Loop orchestration integration

- `bun run test:file -- tests/loop/loop-supervisor-directory.test.ts`
- `bun run test:file -- tests/loop/harness-task-graph-adapter.test.ts`
- `bun run test:file -- tests/loop/loop-orchestration-server.test.ts`
- `bun run test:file -- tests/loop/supervisor-bridge-consumption.test.ts`
- `bun run test:file -- tests/loop/temporal-orchestration-e2e.test.ts`
- `bun run test:ci`
- `bun run check`
- `bun run build`
- `git diff --check`
- Every command must exit zero and each named failure set must be empty.
- The committed candidate must receive an independent literal zero-project-write
  exact-SHA review before any installed runtime or live Loop is changed.

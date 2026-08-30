# Verify: Supervisor orchestration runtime

## Focused gates

```bash
bun run test:file -- tests/loop/supervisor-orchestration-runtime.test.ts
bun run test:file -- tests/loop/temporal-supervisor-runtime.test.ts
```

Require an empty named failure set.

## Full gates

```bash
bun run test:ci
bun run check
bun run build
git diff --check
```

## Acceptance

- Receive through acknowledge persists deterministic lifecycle replacements.
- A denied operation creates no workflow or thread-journal mutation.
- Restart reconstructs category, board, Attention, and knowledge exactly.
- A real ephemeral Temporal server and worker complete the governed path.
- Closing the host stops the worker and does not duplicate runtime ownership.
- Independent committed-object reviewer returns literal PASS with zero project
  writes.


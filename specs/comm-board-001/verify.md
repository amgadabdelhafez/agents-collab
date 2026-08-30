# Verify: durable supervisor threads

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-thread-store.test.ts
```

Require an empty named failure set and direct assertions over on-disk JSONL,
fresh-instance restart reconstruction, event replay/collision, lifecycle update,
corrupt/truncated rows, immutable identity, deterministic ordering, defensive
snapshots, and forbidden-field absence.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Freeze one exact candidate and require independent zero-project-write review.

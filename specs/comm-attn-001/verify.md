# Verify: selective durable supervisor Attention

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-thread-attention-read-model.test.ts
```

Require an empty named failure set and direct assertions over all five message
categories, acknowledged selected membership, informational exclusion across
actions, latest lifecycle replacement, stable ordering/restart/repeat bytes,
corrupt journal refusal, defensive output, and forbidden-field absence.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Freeze one exact candidate and require independent zero-project-write review.

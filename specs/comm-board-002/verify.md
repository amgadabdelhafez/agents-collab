# Verify: durable supervisor artifact references

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-thread-artifact-read-model.test.ts
```

Require an empty named failure set and direct assertions over durable restart,
latest lifecycle replacement, grouping/counts, stable ordering, repeat bytes,
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

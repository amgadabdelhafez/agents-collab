# Verify: KB artifact-reference read model

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-knowledge-artifact-read-model.test.ts
```

Require an empty named failure set and assertions over exact schemas, grouped
backlinks, stable ordering, byte-identical repeat output, defensive data,
malformed input refusal, and forbidden-field absence.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Freeze one exact candidate and require independent zero-project-write review.

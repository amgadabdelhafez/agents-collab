# Verify: durable knowledge artifact read model

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-knowledge-artifact-read-model.test.ts
```

Require an empty named failure set covering both compatibility validation and
the final nominal-store path, including restart, lifecycle replacement, corrupt
journal refusal, defensiveness, and forbidden-field absence.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Freeze one exact candidate and require independent zero-project-write review.

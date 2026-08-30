# Verify: SupervisorMessage board and Attention projections

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/supervisor-message-read-model.test.ts
```

Require an empty named failure set and direct assertions over strict ingestion,
stable ordering, defensive snapshots, Attention membership, bridge JSONL,
workflow revision, and the complete receive/deliver/claim/acknowledge path.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Scan public read-model shapes for body, transcript, credential, local-path, and
engine-specific fields. Freeze one exact candidate and require independent
zero-project-write review.

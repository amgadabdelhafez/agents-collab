# Verify: governed SupervisorMessage delivery

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/governed-supervisor-message.test.ts
```

Require an empty named failure set and direct assertions over bridge JSONL,
workflow inspection, authorization calls, and governance receipts.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Also scan the new source and receipt fixtures for message bodies, absolute local
paths, credential material, and engine SDK imports. Freeze one exact candidate
and require independent zero-project-write review.

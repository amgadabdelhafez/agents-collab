# Verify: operational Temporal orchestration proof

```bash
bun run test:file -- tests/loop/temporal-orchestration-e2e.test.ts
bun run check
bun run build
git diff --check
bun run test:ci
```

Acceptance requires focused and complete tests with zero named failures, exact
authenticated identity binding, an acknowledged durable message, a projected
knowledge artifact, graph dependency blocking and release, and a clean exact
candidate reviewed by an independent zero-write reviewer.


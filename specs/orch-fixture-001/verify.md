# Verify: Deterministic workflow replay corpus

## Focused gates

```bash
cd loop-fork
bun run test:file -- tests/loop/workflow-replay-corpus.test.ts
```

Required: zero failures and an empty named failure set.

## Full gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

## Structural checks

- Corpus source has no `@temporalio`, `@dbos-inc`, or engine adapter imports.
- Every fixture is serializable JSON-safe data.
- Two fresh corpus runs have identical case and aggregate digests.
- Negative runtimes are rejected rather than producing a partial PASS.
- Serialized results contain neither the body sentinel nor the local-path
  sentinel.

## Release gate

Commit the exact candidate and obtain an independent zero-project-write review
through the Claude CLI harness using OpenRouter `z-ai/glm-5.2`. Preserve any
literal refusal before repair.

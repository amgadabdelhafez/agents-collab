# Verification

## Producer-backed fixture

Create a real temporary Git repository containing TypeScript imports, Markdown
links, specs, tests, and two commits. Materialize it through the production
extractor.

## Required claims

- Rebuilding unchanged source produces the same logical nodes, statements, and
  decision-context hash.
- Changing a tracked file changes its evidence hash and commit scope.
- Static imports and local Markdown links become bounded structural edges.
- A candidate cannot claim deterministic `observed` authority.
- An accepted newer statement can supersede rather than delete the old one.
- Time-scoped queries return the statement valid at the requested time.
- Contradictory current statements are reported with both evidence sources.
- Every returned statement has an evidence source and SHA-256.
- Depth and count limits set explicit truncation metadata.
- Corrupt inputs fail nonzero; empty evidence cannot become an observed fact.
- Ordinary `loop` launch argument handling remains unchanged.

## Commands

```bash
bun test tests/loop/world-model.test.ts tests/loop/world-model-cli.test.ts
bun run check
bun test
bun run build
```

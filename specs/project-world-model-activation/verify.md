# Verification

## Producer-backed fixture

Create a real temporary Git repository with committed entry documents,
TypeScript imports, a spec, and a test. Prepare a real run directory through
the production activation function.

## Required claims

- Task text selects only tracked entity labels it actually mentions.
- Promptless or unmatched tasks receive deterministic fallback seeds.
- The database and bootstrap context exist below the run directory.
- The manifest binds exact commit, ontology version, paths, counts, seeds,
  capsule hash, and independently derived file SHA-256.
- Rebuilding unchanged input produces the same logical capsule hash and seeds.
- Corrupt, empty, or non-Git inputs fail before tmux handoff and cancel the
  reserved launch.
- Promptless and task-bound paired launches prepare context before tmux.
- Both fresh agent charters require context hash verification and preserve the
  World Model authority boundary.
- Governed pane environments contain the exact database and context paths.
- Invalid manifest bindings are rejected rather than partially trusted.

## Commands

```bash
bun test tests/loop/world-model-runtime.test.ts tests/loop/run-state.test.ts tests/loop/tmux.test.ts tests/loop.test.ts
bun run check
bun test
bun run build
```

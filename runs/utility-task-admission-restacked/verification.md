# Utility task admission verification

Base: `d63ce10258a27e30946a4b92f7419870b8bb56bd`

## Focused

- `bun run test:file -- tests/loop/task-router.test.ts tests/loop/bridge.test.ts tests/loop/bridge-guidance.test.ts tests/loop/governess-hooks.test.ts tests/loop/review-request-gate.test.ts`
- Result: 224 pass, 0 fail, 733 assertions.

## Repository gates

- `bun run check`: pass.
- TypeScript no-emit command from `docs/testing/commands.md`: pass.
- `bun run build`: pass.
- `bun run test:ci`: pass after updating every affected runtime and linked-worktree request producer to declare `workShape: "separable"`.

The first sandboxed complete run reported `EADDRINUSE` for tests that bind localhost. The same exact integration files passed outside the filesystem sandbox, and the final complete sequential run outside that sandbox exited zero.

## Review transport

- Passing sender regression calls the channel once with `REVIEW_GATE_STAMP_V1` and `status=PASS` in the body.
- Sibling-lineage regression exits nonzero and makes zero channel calls.

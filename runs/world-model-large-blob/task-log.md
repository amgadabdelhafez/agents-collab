# Task world-model-large-blob

Created: 2026-08-06T07:32:20Z
Mode: defect
Description: Fix default-on World Model launch failure on committed blobs larger than Node's default synchronous child-process buffer

## Live incident

- Supervisor message: `63a3f743-e5cf-4643-87f8-35c97eb7f485`
- Exact commit: `ffb783c9c0b997337508fff56de426d807884e9c`
- Exact tracked path: `03-Development/ar-prototype/tests/fixtures/wrap-cloth-rig/anchors-wrap-d55-04e587e4.json`
- Independent `git show` byte count: `2,484,371`
- Launch outcome: fail-closed before loop 138; no live run created.

## Verification

- Producer-backed launch regression: 5 pass, 0 fail, including an exact
  2,484,371-byte committed blob and manifest binding.
- Core World Model materializer: 43 pass, 0 fail.
- `bun run check`: pass, 833 files, no fixes applied.
- Production TypeScript no-emit command: pass.
- `bun run build`: pass.
- `bun run test:ci`: pass with every sorted test file green and an empty
  failure set.
- Exact production repository smoke: candidate materialized Harvto commit
  `ffb783c9c0b997337508fff56de426d807884e9c` into 1,560 entities and 5,721
  statements.
- Exact formerly blocking blob independently hashed and persisted as
  `f18f6fb5b6ffd4c5b87f65fd5adfca7c6b271f841f4c197220f8f77f904d96d5`.
- Disposable SQLite integrity check: `ok`.
- `git diff --check`: pass.

## Scope

- No loop was launched.
- The staged loop-138 worktree was read only.
- No live run, remote branch, main branch, installed binary, or release was
  mutated.

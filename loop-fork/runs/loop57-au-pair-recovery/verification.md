# Verification

## Automated proof

- `./harness verify focused -- bun test tests/loop/utility-tools.test.ts tests/loop/utility-runtime.test.ts tests/loop/bridge.test.ts`
  passed: 159 tests.
- `./harness verify full -- bun run test:ci` passed: 1,104 tests across 55
  files.
- `./harness verify build -- bun run build` passed and produced the compiled
  `loop` binary with SHA-256
  `56339e3480f3968a9b4c2283b080ad35550a642db4e6d2b6fc9edd47ec3afd68`.
- `git diff --check` passed.
- A scoped Ultracite inspection found no new diagnostics in the changed blocks;
  the files retain unrelated pre-existing whole-file lint debt.
- The repository-root `scripts/verify.sh` remains a placeholder and reports
  that lint, typecheck, unit, and integration commands are not configured.

## Live Loop 57 proof

- Successful Au Pair canary: `48b95aa5-d7bd-4acb-9c3c-219d42d8f28f`.
- Requester: `codex`; selected tier: `utility-au-pair`.
- Result: completed with three successful descendant `list_files` calls, no
  `search_repo`, no file changes, and all four requested paths found.
- Bridge ledger entry: `source=utility`, `target=codex`, `type=handover`.
- Viewer borders: `nanny.harvto-loop-57` and `au-pair.harvto-loop-57`.
- Viewer bodies: `QWEN` and `GLM`, with full model/version details reserved for
  Governess and no generated Nanny/Au Pair role labels.
- Preserved primary panes: Claude `%0` PID `70452`; Codex `%1` PID `70454`.

The deliberately invalid canary `95ddf2c0-672f-4b54-a1f4-4a64ca379481`
declared a scope that excluded the target files. It was terminated rather than
allowed to consume more runtime; its failure notification still returned to
Codex, proving requester affinity on a terminal failure path.

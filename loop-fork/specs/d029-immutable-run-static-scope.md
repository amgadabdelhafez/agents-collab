# D-029 Immutable Harness run static-check scope

## Problem

The repository-wide Ultracite command scans immutable Harness evidence under
`runs/`. T16 consequently fails on formatter-only differences in historical
generated JSON, while verify 18 explicitly forbids rewriting those records.

## Required behavior

- Exclude only `loop-fork/runs/**` from the repository formatter/linter scan.
- Keep all source, tests, scripts, and configuration under the normal gate.
- Continue validating each task's generated JSON and eval schema at task close.
- Do not rewrite or delete any historical Harness run record.

## Acceptance

- `bun run check` passes without changing `runs/**`.
- Direct source checking still processes `src/cli.ts`.
- Direct checking of a known historical run artifact reports it as ignored.
- The pre-captured T16 run inventory remains byte-, hash-, and mtime-identical.
- Independent review confirms the exclusion is exact and does not mask source.

# Approach

1. Record baseline full sequential CI run and all remaining files after its first failure; record named failures and baseline check.
2. Delete context-pressure-only production paths and tests. Retain the unrelated 5-hour quota local named sessionPressure. Loader already selects known fields, so removed keys require no compatibility parser.
3. Add high-usage tick and outer-loop regressions plus legacy state load/save coverage. Verify messages absent, handover idle, state identical to normal-usage control.
4. Run full CI plus remaining files, check and diff whitespace check. Prove final named failures are a subset of baseline. Search all source/tests/docs for removed feature.
5. Build/copy/hash candidate, commit explicit paths, request one final peer review. Resolve only concrete review findings; stop at accepted review.

Existing assigned worktree and run instance are isolated. Utility inspection packets are read only; guarded edit routing is disabled because Codex is the sole writer. World Model bootstrap has valid hashes but lacks repository commit binding, so it is not used; Git and manifest bind 4439b2e7 instead.

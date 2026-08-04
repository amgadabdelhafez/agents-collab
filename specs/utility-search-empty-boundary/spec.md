# Spec: Utility Search Empty Boundary

## Problem

In harvto loop 121, Nanny searched plausible child directories inside a
bounded project scope. The directories were absent, and `search_repo` reported
each as `not_found`. Three otherwise safe attempts exhausted the worker's
broker-rejection budget and forced the driver to repeat the inspection.

For text search, a safely contained path that does not exist is an empty search
boundary, not a tool failure.

## Goal

Return a successful empty `search_repo` result for absent paths that remain
inside declared read scope and repository containment, while preserving every
existing fail-closed path, protected-path, symlink, and exact-new-file guard.

## Requirements

1. An absent repository-relative path inside declared read scope contributes
   zero matches and does not fail the whole search.
2. Searches continue across later requested paths after an earlier path is
   absent.
3. A path outside declared read scope remains `scope_denied`, even when absent.
4. A protected path remains `path_denied`, even when absent.
5. A symlink escape remains `path_denied`; absence must not bypass real-path
   containment.
6. Filesystem failures other than absence remain fail-closed.
7. `read_file` and every non-search broker tool keep their existing missing-path
   behavior.
8. The deployed `isExactNewWriteTarget` contract remains present and tested.
9. The deployed shutdown-preservation and proxy-caller-attribution protections
   remain present in the candidate lineage.

## Acceptance criteria

- [x] The loop-121 shape returns `ok: true` with `data: []`.
- [x] A mixed search skips the absent boundary and finds a later match.
- [x] Out-of-scope, protected, and symlink-escape controls fail closed.
- [x] `read_file` of the same absent path still returns `not_found`.
- [x] Exact declared new write targets remain empty search domains.
- [x] The full certified test suite, build, lint, and `git diff --check` pass.
- [x] Content checks find all three deployed protection symbols.

## Non-goals

- Expanding declared read scopes.
- Treating malformed paths, permission failures, or unsafe links as empty.
- Changing helper retry budgets, prompts, or routing tier selection.
- Deploying or mutating a live loop.

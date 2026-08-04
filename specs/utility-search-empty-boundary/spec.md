# Spec: Utility Search Empty Boundary

## Problem

In harvto loop 121, Nanny was asked to locate files inside a bounded project
scope. The model searched plausible child directories that were absent. The
`search_repo` broker reported each absent path as `not_found`, so three
otherwise safe search attempts exhausted the worker's broker-rejection budget
and the driver repeated the inspection natively.

For a text search, a safely contained path that does not exist is an empty
search boundary, not a tool failure. Treating it as an error wastes lower-agent
rounds without protecting any additional data.

## Goal

Return a successful empty `search_repo` result for absent paths that remain
inside declared read scope and repository containment, while preserving every
existing fail-closed path, protected-path, and symlink boundary.

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
8. Limits on files, matches, output, and execution remain unchanged.

## Acceptance criteria

- [ ] The loop-121 shape, searching an absent child directory inside a valid
      project read scope, returns `ok: true` with `data: []`.
- [ ] A mixed search skips the absent boundary and returns matches from an
      existing later boundary.
- [ ] Out-of-scope, protected, and symlink-escape negative controls still fail
      closed.
- [ ] `read_file` of the same absent path still returns `not_found`.
- [ ] Focused broker tests, the full repository verification gate, build, and
      `git diff --check` pass with no tolerated baseline failures.

## Non-goals

- Expanding declared read scopes.
- Treating malformed paths, permission failures, or unsafe links as empty.
- Changing helper retry budgets, model prompts, or routing tier selection.
- Deploying or mutating a live loop.

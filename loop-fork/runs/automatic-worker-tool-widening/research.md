# automatic-worker-tool-widening Research

## Research Question

Which existing local abstractions and runtime primitives let the automatic GLM
worker execute more focused tests and bounded inspection while preserving
literal argv, path containment, output limits, and fail-closed routing?

## Candidates Reviewed

- Existing `UtilityToolBroker` plus `runUtilityCommand`: already provides
  literal argv, sanitized environment, timeout/kill, shared output budget,
  command allowlists, local-binary enforcement, scope validation, and durable
  tool events. Best fit; extend rather than replace.
- Existing delegation literal tokenizer and `decomposeSafeCompound`: already
  rejects substitution, globs, general redirects, arbitrary chains, and unsafe
  paths. Best fit for exact new grammars.
- Bun `spawn`: accepts an argv string array and explicit cwd/environment and
  exposes separate bounded stdout/stderr streams. This matches the existing
  no-shell broker execution design.
- Node `fs/promises.readdir({withFileTypes:true})`: returns `Dirent` values
  without needing shell `ls`, enabling a non-recursive listing tool that can
  filter protected entries before returning evidence.
- Vitest `run` with filename filters: official CLI behavior supports a
  terminating non-watch run narrowed by file filters. This matches the
  existing `npx vitest run` broker policy; arbitrary Vitest flags are not
  needed.
- General shell/PTY harnesses: rejected. They broaden authority far beyond the
  requested automatic mechanical work and make path/output equivalence harder
  to prove.

## Open-Source Patterns

- Spawn commands as an argv array, not a shell string; make cwd/environment
  explicit and separately bound stdout/stderr.
- Use filesystem APIs rather than shell listing so containment, symlink, entry,
  and protected-path checks occur before data is returned.
- Use non-watch test mode plus explicit filename filters for focused tests.
- Separate classification from execution: the classifier proves a narrow
  command shape, and the broker independently revalidates every path/argument.
- Expose one matching tool per automatic request to prevent capability churn.

## Reuse Decision

Adapt the existing classifier, request schema, runtime profiles, and broker. Add
one filesystem-native `list_files` tool; reuse `run_check`, `search_repo`, and
`read_file` for the other families. Do not add an external command parser,
shell, agent framework, or dependency. Preserve the current literal tokenizer
and independently validate broker inputs. This is the smallest change with the
strongest continuity of existing security tests and observability.

## Sources

- https://bun.sh/docs/runtime/child-process
- https://nodejs.org/api/fs.html
- https://vitest.dev/guide/cli
- Local source: `src/loop/delegation-policy.ts`
- Local source: `src/loop/utility-tools.ts`
- Local source: `src/loop/utility-runtime.ts`

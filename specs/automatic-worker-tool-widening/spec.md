# Spec: Automatic Worker Tool Widening

## Problem

The automatic GLM worker is now satisfiable for bounded reads, search, Git
status/diff, and Git metadata, but run 51 still left most mechanical work with
Claude. Its 88 Bash calls included 16 focused test commands, 12 searches, 12
bounded file slices, and 9 directory inspections. The broker already supports
focused tests explicitly, while the automatic classifier cannot preserve their
working directory or accept the common `2>&1 | head/tail` shape. It has no
bounded directory-list tool, recognizes `rg` but not safe literal `grep`, and
does not recognize bounded `awk`/`tail` reads.

Broadening to arbitrary shell would let a lower-cost model execute mutation,
network, secrets, or unreviewed repository code. The safe expansion must remain
exact, path-scoped, bounded, observable, and broker-enforced.

## Goal

Automatically route more low-risk local work to GLM-5.2 without making GLM an
interactive agent and without granting a shell. Add exact support for focused
tests, one-directory listings, literal grep searches, and bounded awk/tail
reads. Every new automatic operation must expose only its matching broker tool
and preserve the requested cwd, paths, and output bound.

## In scope

- Route `bun test <1-4 files>` and `npx vitest run <1-4 files>` with literal
  paths, optional safe `cd`, optional exact `2>&1`, and optional `head`/`tail`
  evidence bounds.
- Require a local Vitest binary and offline `npx`; retain the broker's 60-second
  command timeout, sanitized environment, output cap, and path validation.
- Add a bounded `list_files` broker tool for one declared directory. It may
  include ordinary hidden entries when requested but must omit protected paths,
  refuse symlink traversal, cap entries/output, and never recurse.
- Route standalone safe `ls` shapes with a single literal directory and
  display-only flags (`-a`, `-l`, `-la`, `-al`), plus the existing optional
  safe `cd`, stderr marker, and `head`/`tail` evidence bound.
- Route `grep` only when its pattern is provably literal: `-F`/`--fixed-strings`
  or a pattern containing no regex metacharacters. Allow only bounded line,
  case, recursion, and fixed-string flags; require one to four safe paths.
- Route exact bounded `awk` line selectors (`NR<=N` or
  `NR>=A && NR<=B`) and `tail -n N <file>`/`tail -N <file>` with at most 500
  returned lines.
- Persist the execution cwd for focused checks and fail closed if it is absent,
  malformed, protected, outside the verified workspace, or not a directory.
- Add red-first classifier, broker, runtime, persistence, output-budget, and
  negative security tests.
- Deploy only after independent evaluation and preserve active Claude/Codex
  panes.

## Non-goals

- Arbitrary `node`, Python, Perl, shell scripts, heredocs, eval strings, or
  executables configured only by model output.
- Automatic `Edit` or `Write` interception. Claude has already authored those
  payloads, so rerunning a model adds latency without meaningful token savings.
- `git add`, commit, push, checkout, fetch, PR creation, remote calls, package
  installation, process inspection, waits/polls, or destructive commands.
- Full-suite tests without explicit file paths, watch mode, snapshots/update
  flags, coverage, arbitrary test-runner options, or more than four test files.
- Recursive file listing, following symlinks, reading temporary paths outside
  the verified repository, or exposing protected/governing paths.
- Raising worker concurrency. This task increases safe eligibility and keeps
  the existing bounded pool.

## Acceptance criteria

- [x] The four new families classify only their exact safe forms and reject
      mixed, mutating, ambiguous, unbounded, option-injected, glob-expanded,
      protected, symlinked, and out-of-repository variants.
- [x] Automatic focused checks expose only `run_check`; listings expose only
      `list_files`; grep exposes only `search_repo`; slices expose only
      `read_file`.
- [x] Focused-check cwd and path semantics survive request creation,
      persistence, workspace adoption, and broker execution.
- [x] `2>&1` is accepted only in the exact stderr position and never becomes
      general redirection authority.
- [x] `list_files` returns at most the configured entry/output limits, filters
      protected entries, and refuses non-directories and symlink escapes.
- [x] Search/read/list/check outputs remain within 64 KiB; input files remain
      bounded at 1 MiB.
- [x] Existing safe grammar and all fail-closed security tests remain green.
- [x] Focused, full, static, build, and diff verification are recorded; known
      baseline failures are separated from regressions.
- [x] An independent evaluator passes the change before deployment.
- [ ] A live focused-test canary and at least one new inspection-family canary
      complete with zero denied-tool calls, while Claude/Codex PIDs remain
      unchanged and governess doctor passes.
